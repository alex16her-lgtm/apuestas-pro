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
window.refAnalisis = db.collection("analisis_partidos");

/*************************************************
 * 🔐 CONTROL DE REQUESTS
 *************************************************/
const MAX_REQUESTS_DIA = 100;

async function canMakeRequest(){
  const today = new Date().toISOString().slice(0,10);
  const ref = db.collection("api_control").doc(today);
  const doc = await ref.get();
  if(!doc.exists){ await ref.set({ count: 0 }); return true; }
  return doc.data().count < MAX_REQUESTS_DIA;
}

async function registerRequest(){
  const today = new Date().toISOString().slice(0,10);
  const ref = db.collection("api_control").doc(today);
  await ref.update({ count: firebase.firestore.FieldValue.increment(1) });
}

/*************************************************
 * 🌐 PROXY HELPER
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";

async function fetchFromProxy(targetApiUrl) {
  // Convertimos a Base64 para proteger la URL
  const base64Url = btoa(targetApiUrl);
  const finalProxyUrl = `${WORKER_URL}?base64=${base64Url}`;
  
  // console.log(`📡 Solicitando: ${targetApiUrl}`); // (Opcional: puedes borrar este log)
  
  const res = await fetch(finalProxyUrl);
  return await res.json();
}

/*************************************************
 * 🧠 1. OBTENER TEAM ID
 *************************************************/
async function getTeamIdByName(teamName){
  try {
    // 🔴 CORRECCIÓN AQUÍ: "encodeURIComponent" arregla el espacio de "Real Madrid"
    const safeName = encodeURIComponent(teamName);
    const data = await fetchFromProxy(`https://v3.football.api-sports.io/teams?search=${safeName}`);
    
    if(!data.response || !data.response.length){
      console.warn("❌ Equipo no encontrado:", teamName);
      return null;
    }
    return data.response[0].team.id;
  } catch (e) {
    console.error("Error ID:", e);
    return null;
  }
}

/*************************************************
 * 🧠 2. FUNCIÓN PRINCIPAL
 *************************************************/
async function getTeamData(teamName){
  console.log(`🚀 Iniciando para: ${teamName}`);

  // A. CACHÉ
  const cacheRef = db.collection("cache_equipos").doc(`${teamName.replace(/\s+/g, '_')}`);
  const cache = await cacheRef.get();
  if(cache.exists){
    const last = cache.data().updated?.toDate();
    if(last && (Date.now() - last.getTime()) / 36e5 < 12 && cache.data().partidos?.length){
      console.log("📦 Desde Caché");
      return cache.data().partidos;
    }
  }

  // B. VALIDAR LÍMITES
  if(!(await canMakeRequest())) return [];

  // C. OBTENER ID
  const teamId = await getTeamIdByName(teamName);
  if(!teamId) return [];

  // D. OBTENER PARTIDOS (Temporada 2024 -> 2023)
  let urlFixtures = `https://v3.football.api-sports.io/fixtures?team=${teamId}&season=2024&status=FT`;
  let fixData = await fetchFromProxy(urlFixtures);

  if(!fixData.response || !fixData.response.length){
    console.warn("⚠️ Temp 2024 vacía, probando 2023...");
    urlFixtures = `https://v3.football.api-sports.io/fixtures?team=${teamId}&season=2023&status=FT`;
    fixData = await fetchFromProxy(urlFixtures);
  }

  if(!fixData.response || !fixData.response.length) return [];

  // E. FILTRAR Y ORDENAR
  let todos = fixData.response.filter(p => ['FT','AET','PEN'].includes(p.fixture.status.short));
  todos.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  
  const ultimos10 = todos.slice(0, 10);
  const partidos = [];

  console.log(`🎫 Procesando ${ultimos10.length} partidos...`);

  // F. DETALLE ESTADÍSTICAS
  for(const f of ultimos10){
    const statData = await fetchFromProxy(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${f.fixture.id}`);
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    
    // 🔥 FUNCIÓN PARA EXTRAER VALOR SEGURO
    const getRaw = (name) => {
        if(!statsTeam) return 0;
        const item = statsTeam.statistics.find(x => x.type === name);
        return (item && item.value !== null) ? Number(item.value) : 0;
    };

    // 🔥 CÁLCULO INTELIGENTE DE TIROS TOTALES (TT)
    // A veces la API trae "Shots total", a veces "Total Shots", a veces nada.
    let totalShots = getRaw("Shots total") || getRaw("Total Shots");
    
    // Si sigue siendo 0, lo calculamos manualmente: (A Puerta + Fuera + Bloqueados)
    if (totalShots === 0) {
        totalShots = getRaw("Shots on Goal") + getRaw("Shots off Goal") + getRaw("Blocked Shots");
    }

    const isHome = f.teams.home.id === teamId;

    partidos.push({
      fecha: f.fixture.date,
      rival: isHome ? f.teams.away.name : f.teams.home.name,
      local: isHome,
      stats: {
        tt: totalShots, // <--- Aquí va el valor corregido
        tap: getRaw("Shots on Goal"),
        cor: getRaw("Corner Kicks"),
        tar: getRaw("Yellow Cards") + getRaw("Red Cards"), // Sumamos rojas por si acaso
        gol: isHome ? f.goals.home : f.goals.away
      }
    });

    await new Promise(r => setTimeout(r, 250));
  }

  // G. GUARDAR EN CACHÉ
  if(partidos.length){
    await cacheRef.set({
      team: teamName,
      partidos,
      updated: firebase.firestore.FieldValue.serverTimestamp()
    });
    await registerRequest();
  }
  console.log("✅ Datos procesados correctamente.");
  return partidos;
}

// Exportar
window.db = db;
window.getTeamIdByName = getTeamIdByName;
window.getTeamData = getTeamData;

// Utilidad simple para HTML
window.promedio = function(partidos, campo){
  if(!partidos || !partidos.length) return 0;
  return (partidos.reduce((a,p)=>a+(p.stats[campo]||0),0) / partidos.length).toFixed(1);
};
