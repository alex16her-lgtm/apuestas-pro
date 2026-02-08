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
    
    // DETECTOR DE LÍMITES
    if(data.errors && Object.keys(data.errors).length > 0){
        console.error("🚨 ERROR API (Buscando Equipo):", data.errors);
        if(JSON.stringify(data.errors).includes("limit") || JSON.stringify(data.errors).includes("requests")){
             alert("⚠️ API DETENIDA: Se acabaron las peticiones gratuitas por hoy. Intenta mañana.");
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
 * 🧠 2. FUNCIÓN PRINCIPAL (Barrido 3 Años)
 *************************************************/
async function getTeamData(teamName, forceUpdate = false){
  const currentYear = new Date().getFullYear(); // 2026
  
  // Vamos a probar 3 años hacia atrás para asegurar datos
  const yearsToCheck = [currentYear, currentYear - 1, currentYear - 2]; 

  console.log(`🚀 Iniciando para: ${teamName} | Buscando en: ${yearsToCheck.join(", ")}`);

  // A. CACHÉ V5
  const cacheKey = `${teamName.replace(/\s+/g, '_')}_v5`;
  const cacheRef = db.collection("cache_equipos").doc(cacheKey);
  
  if(!forceUpdate){
    const cache = await cacheRef.get();
    if(cache.exists){
      const last = cache.data().updated?.toDate();
      if(last && (Date.now() - last.getTime()) / 36e5 < 12 && cache.data().partidos?.length){
        console.log("📦 Usando memoria guardada (Ahorrando API)");
        return cache.data().partidos;
      }
    }
  } else {
    console.warn("🔄 Forzando actualización de datos...");
  }

  // B. VALIDAR LÍMITES
  if(!(await canMakeRequest())) return [];

  // C. OBTENER ID
  const teamId = await getTeamIdByName(teamName);
  if(!teamId) return [];

  // D. OBTENER PARTIDOS (Bucle inteligente)
  let fixData = null;
  let foundYear = null;

  for (let year of yearsToCheck) {
    console.log(`🔎 Probando temporada ${year}...`);
    const url = `https://v3.football.api-sports.io/fixtures?team=${teamId}&season=${year}&status=FT`;
    const data = await fetchFromProxy(url);

    // 1. Verificar Errores de API (Rate Limit)
    if(data.errors && Object.keys(data.errors).length > 0){
        console.error(`🚨 Error en temporada ${year}:`, data.errors);
        if(JSON.stringify(data.errors).includes("limit") || JSON.stringify(data.errors).includes("requests")){
            alert(`⚠️ ERROR DE API: Límite diario alcanzado al buscar en ${year}.`);
            return []; // Detenemos todo
        }
    }

    // 2. Si encontramos partidos, nos detenemos aquí
    if(data.response && data.response.length > 0){
        fixData = data;
        foundYear = year;
        console.log(`✅ ¡Encontrados ${data.response.length} partidos en ${year}!`);
        break; // Salimos del bucle
    }
  }

  if(!fixData || !fixData.response || !fixData.response.length) {
    console.error("❌ No se encontraron partidos en 2026, 2025 ni 2024.");
    return [];
  }

  // E. ORDENAR Y CORTAR
  let todos = fixData.response.filter(p => ['FT','AET','PEN'].includes(p.fixture.status.short));
  todos.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  
  const ultimos10 = todos.slice(0, 10);
  const partidos = [];

  console.log(`🎫 Procesando detalle de ${ultimos10.length} partidos...`);

  // F. DETALLE ESTADÍSTICAS
  for(const f of ultimos10){
    const statData = await fetchFromProxy(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${f.fixture.id}`);
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    
    // Helper Seguro
    const getVal = (name) => {
        if(!statsTeam) return 0;
        const item = statsTeam.statistics.find(x => x.type === name);
        return (item && item.value !== null) ? Number(item.value) : 0;
    };

    // 🔥 CÁLCULO TIROS
    let totalShots = getVal("Shots total") || getVal("Total Shots");
    if (totalShots === 0) totalShots = getVal("Goal Attempts");
    if (totalShots === 0) totalShots = getVal("Shots on Goal") + getVal("Shots off Goal") + getVal("Blocked Shots");

    const isHome = f.teams.home.id === teamId;
    const rivalName = isHome ? f.teams.away.name : f.teams.home.name;

    // Log para verificar fecha y año
    console.log(`📅 [${f.fixture.date.slice(0,10)}] vs ${rivalName} | Tiros: ${totalShots}`);

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

    await new Promise(r => setTimeout(r, 400));
  }

  // G. GUARDAR
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

window.db = db;
window.getTeamIdByName = getTeamIdByName;
window.getTeamData = getTeamData;

window.promedio = function(partidos, campo){
  if(!partidos || !partidos.length) return 0;
  return (partidos.reduce((a,p)=>a+(p.stats[campo]||0),0) / partidos.length).toFixed(1);
};
