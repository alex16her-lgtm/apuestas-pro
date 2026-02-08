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
 * 🔐 CONTROL DE REQUESTS LOCAL
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
  const base64Url = btoa(targetApiUrl);
  const finalProxyUrl = `${WORKER_URL}?base64=${base64Url}`;
  const res = await fetch(finalProxyUrl);
  return await res.json();
}

/*************************************************
 * 🧠 1. OBTENER TEAM ID
 *************************************************/
async function getTeamIdByName(teamName){
  try {
    const safeName = encodeURIComponent(teamName);
    const data = await fetchFromProxy(`https://v3.football.api-sports.io/teams?search=${safeName}`);
    
    // 🚨 DETECTOR DE LÍMITE DE API 🚨
    if(data.errors && Object.keys(data.errors).length > 0){
        console.error("🚨 ERROR API:", data.errors);
        if(JSON.stringify(data.errors).includes("requests")){
            alert("⚠️ HAS ALCANZADO EL LÍMITE DIARIO DE LA API (100 Peticiones). Intenta mañana.");
        }
        return null;
    }

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

  // A. CACHÉ V3 (Para forzar actualización si tenías datos malos)
  const cacheRef = db.collection("cache_equipos").doc(`${teamName.replace(/\s+/g, '_')}_v3`);
  const cache = await cacheRef.get();
  if(cache.exists){
    const last = cache.data().updated?.toDate();
    if(last && (Date.now() - last.getTime()) / 36e5 < 12 && cache.data().partidos?.length){
      console.log("📦 Desde Caché (Ahorrando API)");
      return cache.data().partidos;
    }
  }

  // B. VALIDAR LÍMITES
  if(!(await canMakeRequest())) return [];

  // C. OBTENER ID
  const teamId = await getTeamIdByName(teamName);
  if(!teamId) return []; // Aquí se detiene si hay error de API

  // D. OBTENER PARTIDOS
  let urlFixtures = `https://v3.football.api-sports.io/fixtures?team=${teamId}&season=2024&status=FT`;
  let fixData = await fetchFromProxy(urlFixtures);

  // Detector de errores en fixtures
  if(fixData.errors && Object.keys(fixData.errors).length > 0){
      console.error("🚨 Error buscando partidos:", fixData.errors);
      return [];
  }

  // Fallback a 2023
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

  console.log(`🎫 Descargando ${ultimos10.length} partidos...`);

  // F. DETALLE ESTADÍSTICAS
  for(const f of ultimos10){
    const statData = await fetchFromProxy(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${f.fixture.id}`);
    
    // Buscamos stats SOLO de nuestro equipo
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    
    // Función Helper para sacar valor numérico
    const getVal = (name) => {
        if(!statsTeam) return 0;
        const item = statsTeam.statistics.find(x => x.type === name);
        return (item && item.value !== null) ? Number(item.value) : 0;
    };

    // 🔥 CÁLCULO TIROS (TRIPLE CHECK)
    // 1. Intento Directo
    let totalShots = getVal("Shots total") || getVal("Total Shots");
    
    // 2. Intento Alternativo (Goal Attempts)
    if (totalShots === 0) totalShots = getVal("Goal Attempts");

    // 3. Intento Suma Manual
    if (totalShots === 0) {
        totalShots = getVal("Shots on Goal") + getVal("Shots off Goal") + getVal("Blocked Shots");
    }

    // 4. Intento Caja (Dentro + Fuera)
    if (totalShots === 0) {
        totalShots = getVal("Shots insidebox") + getVal("Shots outsidebox");
    }

    const isHome = f.teams.home.id === teamId;
    const rivalName = isHome ? f.teams.away.name : f.teams.home.name;

    // DEBUG para ver por qué sale 0
    if(totalShots === 0){
        console.warn(`⚠️ TIROS 0 vs ${rivalName}. Datos API:`, statsTeam ? statsTeam.statistics : "Sin datos");
    }

    partidos.push({
      fecha: f.fixture.date,
      rival: rivalName,
      local: isHome,
      stats: {
        tt: totalShots, 
        tap: getVal("Shots on Goal"),
        cor: getVal("Corner Kicks"),
        tar: getVal("Yellow Cards") + getVal("Red Cards"),
        gol: isHome ? f.goals.home : f.goals.away
      }
    });

    // Pausa un poco más larga para evitar bloqueos
    await new Promise(r => setTimeout(r, 300));
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

  return partidos;
}

// EXPORTAR
window.db = db;
window.getTeamIdByName = getTeamIdByName;
window.getTeamData = getTeamData;
window.promedio = function(partidos, campo){
  if(!partidos || !partidos.length) return 0;
  return (partidos.reduce((a,p)=>a+(p.stats[campo]||0),0) / partidos.length).toFixed(1);
};
