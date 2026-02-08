/*************************************************
 * 🔥 FIREBASE CONFIG
 *************************************************/
const firebaseConfig = {
  apiKey: "AIzaSyBtOk-otWrGU7ljda52yhVhSvQKaG3siRM",
  authDomain: "apuestas-analisis.firebaseapp.com",
  projectId: "apuestas-analisis",
  storageBucket: "apuestas-analisis.firebasestorage.app",
  messagingSenderId: "542021066839",
  appId: "1:542021066839:web:bb6a43f578a39d07c68312"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db = firebase.firestore();

// EXPORTAR REFERENCIA PARA QUE EL HTML LA VEA
window.refAnalisis = db.collection("analisis_partidos");

/*************************************************
 * 🔐 CONTROL DE REQUESTS (API FREE)
 *************************************************/
const MAX_REQUESTS_DIA = 100;

async function canMakeRequest(){
  const today = new Date().toISOString().slice(0,10);
  const ref = db.collection("api_control").doc(today);
  const doc = await ref.get();

  if(!doc.exists){
    await ref.set({ count: 0 });
    return true;
  }
  return doc.data().count < MAX_REQUESTS_DIA;
}

async function registerRequest(){
  const today = new Date().toISOString().slice(0,10);
  const ref = db.collection("api_control").doc(today);
  await ref.update({
    count: firebase.firestore.FieldValue.increment(1)
  });
}

/*************************************************
 * 🌐 CLOUDFLARE WORKER (PROXY)
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";

/*************************************************
 * 🧠 OBTENER TEAM ID POR NOMBRE
 *************************************************/
async function getTeamIdByName(teamName){
  try {
    // Codificamos la URL interna para que pase limpia por el proxy
    const apiUrl = `https://v3.football.api-sports.io/teams?search=${teamName}`;
    const proxyUrl = `${WORKER_URL}?url=${encodeURIComponent(apiUrl)}`;
    
    const res = await fetch(proxyUrl);
    const data = await res.json();

    console.log(`🔎 Buscando ID para ${teamName}:`, data);

    if(!data.response || !data.response.length){
      console.warn("❌ Equipo no encontrado:", teamName);
      return null;
    }

    // Tomamos el primer resultado (normalmente es el equipo principal)
    return data.response[0].team.id;
  } catch (e) {
    console.error("Error buscando equipo ID:", e);
    return null;
  }
}

/*************************************************
 * 🧠 OBTENER ÚLTIMOS 10 PARTIDOS
 *************************************************/
async function getTeamData(teamName){
  console.log(`🚀 Iniciando análisis para: ${teamName}`);

  // 1. CACHÉ (Ahorrar API)
  const cacheRef = db.collection("cache_equipos").doc(`${teamName.replace(/\s+/g, '_')}`);
  const cache = await cacheRef.get();

  if(cache.exists){
    const last = cache.data().updated?.toDate();
    if(last){
      const diff = (Date.now() - last.getTime()) / 1000 / 60 / 60;
      if(diff < 12 && cache.data().partidos?.length){
        console.log("📦 Usando datos guardados (Caché)");
        return cache.data().partidos;
      }
    }
  }

  // 2. CHECK LIMITES
  if(!(await canMakeRequest())){
    console.warn("⚠️ Límite diario excedido");
    return [];
  }

  // 3. OBTENER ID
  const teamId = await getTeamIdByName(teamName);
  if(!teamId) return [];

  // 4. OBTENER PARTIDOS (FIXTURES)
  // IMPORTANTE: encodeURIComponent asegura que "&last=10" llegue a la API
  const apiUrl = `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=10&status=FT`;
  const proxyUrl = `${WORKER_URL}?url=${encodeURIComponent(apiUrl)}`;

  console.log("📡 Pidiendo partidos a la API...");
  const fixRes = await fetch(proxyUrl);
  const fixData = await fixRes.json();

  if(!fixData.response || !fixData.response.length){
    console.warn("⚠️ La API no devolvió partidos.");
    return [];
  }

  const partidos = [];
  console.log(`🎫 Procesando ${fixData.response.length} partidos...`);

  // 5. OBTENER ESTADÍSTICAS POR PARTIDO
  for(const f of fixData.response){
    const fixtureId = f.fixture.id;
    
    // Pedir stats específicas de este partido
    const statsUrl = `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`;
    const statsProxy = `${WORKER_URL}?url=${encodeURIComponent(statsUrl)}`;

    const statRes = await fetch(statsProxy);
    const statData = await statRes.json();
    
    // Filtrar stats solo de NUESTRO equipo
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    
    if(!statsTeam) {
        console.log(`⚠️ Sin stats detalladas para el partido ${fixtureId}`);
        continue;
    }

    // Función auxiliar para sacar el valor numérico
    const getStat = (type) => {
        const item = statsTeam.statistics.find(x => x.type === type);
        return item ? (item.value || 0) : 0;
    };

    const isHome = f.teams.home.id === teamId;

    partidos.push({
      fecha: f.fixture.date,
      rival: isHome ? f.teams.away.name : f.teams.home.name,
      local: isHome,
      stats: {
        tt: getStat("Shots total"),
        tap: getStat("Shots on Goal"),
        cor: getStat("Corner Kicks"),
        tar: getStat("Yellow Cards"),
        gol: isHome ? f.goals.home : f.goals.away
      }
    });

    // Pequeña pausa para no saturar tu API (Rate Limit)
    await new Promise(r => setTimeout(r, 400));
  }

  // 6. GUARDAR RESULTADO
  if(partidos.length){
    await cacheRef.set({
      team: teamName,
      partidos,
      updated: firebase.firestore.FieldValue.serverTimestamp()
    });
    await registerRequest();
  }

  console.log("✅ Análisis completado:", partidos);
  return partidos;
}

/*************************************************
 * 📊 UTILIDADES
 *************************************************/
function promedio(partidos, campo){
  if(!partidos.length) return 0;
  return (
    partidos.reduce((a,p)=>a+(p.stats[campo]||0),0) / partidos.length
  ).toFixed(1);
}

/*************************************************
 * 🌍 EXPORTAR AL WINDOW
 *************************************************/
window.db = db;
window.getTeamIdByName = getTeamIdByName;
window.getTeamData = getTeamData;
window.promedio = promedio;
