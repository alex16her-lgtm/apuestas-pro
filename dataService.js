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

// Inicializar solo si no existe
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db = firebase.firestore();

// 🔴 ARREGLO 1: Exportar la referencia que busca tu HTML
// Asegúrate de que "analisis_partidos" es el nombre de tu colección en Firebase
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
 * 🧠 OBTENER TEAM ID
 *************************************************/
async function getTeamIdByName(teamName){
  try {
    const res = await fetch(
      `${WORKER_URL}?url=${encodeURIComponent(`https://v3.football.api-sports.io/teams?search=${teamName}`)}`
    );
    const data = await res.json();
    
    // 🔥 DEBUG: Ver qué responde realmente la API
    console.log("🔍 Respuesta API para " + teamName, data); 

    if (data.errors && Object.keys(data.errors).length > 0) {
        console.error("🚨 ERROR DE API:", data.errors);
        alert("Error de API: " + JSON.stringify(data.errors));
        return null;
    }

    if(!data.response || !data.response.length){
      console.warn("❌ Equipo no encontrado (array vacío):", teamName);
      return null;
    }

    return data.response[0].team.id;
  } catch (e) {
    console.error("Error buscando equipo ID:", e);
    return null;
  }
}

/*************************************************
 * 🧠 OBTENER ÚLTIMOS 10 PARTIDOS
 *************************************************/
async function getTeamData(teamName, leagueId){
  // 1. Intentar cargar de caché
  const cacheRef = db.collection("cache_equipos").doc(`${teamName.replace(/\s+/g, '_')}_${leagueId}`);
  const cache = await cacheRef.get();

  if(cache.exists){
    const last = cache.data().updated?.toDate();
    if(last){
      const diff = (Date.now() - last.getTime()) / 1000 / 60 / 60; // Horas
      if(diff < 12 && cache.data().partidos?.length){
        console.log("📦 Cache usado para:", teamName);
        return cache.data().partidos;
      }
    }
  }

  // 2. Verificar límites
  if(!(await canMakeRequest())){
    console.warn("⚠️ Límite diario de API alcanzado");
    return [];
  }

  // 3. Buscar ID y Datos
  const teamId = await getTeamIdByName(teamName);
  if(!teamId) return [];

  // Fetch fixtures (Partidos)
  const urlFixtures = `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=10&status=FT`; // Quitamos league=${leagueId} para traer general si quieres
  const fixRes = await fetch(`${WORKER_URL}?url=${encodeURIComponent(urlFixtures)}`);
  const fixData = await fixRes.json();

  if(!fixData.response?.length) return [];

  const partidos = [];

  // 4. Loop para sacar estadísticas (Cuidado con el consumo de API aquí)
  // Nota: Esto hace 1 llamada por partido. Si traes 10, son 10 llamadas.
  for(const f of fixData.response){
    const statRes = await fetch(
      `${WORKER_URL}?url=${encodeURIComponent(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${f.fixture.id}`)}`
    );
    const statData = await statRes.json();
    
    // Buscar stats de ESTE equipo
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    
    // Si no hay stats detalladas, saltamos o ponemos 0
    if(!statsTeam) continue;

    const getStat = (type) => {
        const item = statsTeam.statistics.find(x => x.type === type);
        return item ? (item.value || 0) : 0;
    };

    const isHome = f.teams.home.id === teamId;
    const golesFavor = isHome ? f.goals.home : f.goals.away;

    // 🔴 ARREGLO 2: Mapear a las variables que usa tu HTML (tt, tap, cor...)
    partidos.push({
      fecha: f.fixture.date,
      rival: isHome ? f.teams.away.name : f.teams.home.name,
      local: isHome,
      stats: {
        tt: getStat("Shots total"),
        tap: getStat("Shots on Goal"),
        cor: getStat("Corner Kicks"),
        tar: getStat("Yellow Cards"), // O Cards Red + Yellow
        gol: golesFavor
      }
    });
    
    // Pequeña pausa para no saturar
    await new Promise(r => setTimeout(r, 200));
  }

  // 5. Guardar en Caché
  if(partidos.length){
    await cacheRef.set({
      team: teamName,
      partidos,
      updated: firebase.firestore.FieldValue.serverTimestamp()
    });
    await registerRequest(); // Contamos como 1 request "lógica" o puedes contar +10 si prefieres ser estricto
  }

  return partidos;
}

/*************************************************
 * 🌍 EXPORTAR AL WINDOW
 *************************************************/
window.db = db;
window.getTeamData = getTeamData;
