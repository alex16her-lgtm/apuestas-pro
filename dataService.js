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
 * 🌐 PROXY HELPER (BASE 64)
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";

// Usamos Base64 para pasar URL complejas sin que Cloudflare las rompa
async function fetchFromProxy(targetApiUrl) {
  const base64Url = btoa(targetApiUrl);
  const finalProxyUrl = `${WORKER_URL}?base64=${base64Url}`;
  console.log(`📡 Solicitando: ${targetApiUrl}`); // Log limpio
  const res = await fetch(finalProxyUrl);
  return await res.json();
}

/*************************************************
 * 🧠 1. OBTENER TEAM ID
 *************************************************/
async function getTeamIdByName(teamName){
  try {
    const data = await fetchFromProxy(`https://v3.football.api-sports.io/teams?search=${teamName}`);
    
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
 * 🧠 2. FUNCIÓN PRINCIPAL (Lógica Plan Gratis)
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

  // D. OBTENER PARTIDOS (SIN usar 'last', pidiendo temporada completa)
  // Probamos primero temporada 2024
  let urlFixtures = `https://v3.football.api-sports.io/fixtures?team=${teamId}&season=2024&status=FT`;
  let fixData = await fetchFromProxy(urlFixtures);

  // Si 2024 está vacía, probamos 2023
  if(!fixData.response || !fixData.response.length){
    console.warn("⚠️ Temporada 2024 vacía, intentando 2023...");
    urlFixtures = `https://v3.football.api-sports.io/fixtures?team=${teamId}&season=2023&status=FT`;
    fixData = await fetchFromProxy(urlFixtures);
  }

  if(!fixData.response || !fixData.response.length){
    console.error("❌ Sin partidos en 2023 ni 2024. Error:", fixData.errors);
    return [];
  }

  // E. FILTRAR LOS ÚLTIMOS 10 MANUALMENTE (Ya que la API no nos deja)
  let todosLosPartidos = fixData.response;
  
  // Ordenar: Más recientes primero
  todosLosPartidos.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  
  // Cortar los primeros 10
  const ultimos10 = todosLosPartidos.slice(0, 10);
  
  const partidos = [];
  console.log(`🎫 Procesando stats de los últimos ${ultimos10.length} partidos...`);

  // F. DETALLE ESTADÍSTICAS (Esto sí permite el plan gratis por ID)
  for(const f of ultimos10){
    const fixtureId = f.fixture.id;
    
    const statData = await fetchFromProxy(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`);
    
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    
    // Si no hay stats (a veces pasa en ligas menores), ponemos 0
    const getVal = (type) => statsTeam ? (statsTeam.statistics.find(x => x.type === type)?.value || 0) : 0;
    
    const isHome = f.teams.home.id === teamId;

    partidos.push({
      fecha: f.fixture.date,
      rival: isHome ? f.teams.away.name : f.teams.home.name,
      local: isHome,
      stats: {
        tt: getVal("Shots total"),
        tap: getVal("Shots on Goal"),
        cor: getVal("Corner Kicks"),
        tar: getVal("Yellow Cards"),
        gol: isHome ? f.goals.home : f.goals.away
      }
    });

    // Pausa técnica para no saturar
    await new Promise(r => setTimeout(r, 250));
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

  console.log("✅ Datos obtenidos:", partidos);
  return partidos;
}

/*************************************************
 * 📊 UTILIDADES
 *************************************************/
function promedio(partidos, campo){
  if(!partidos.length) return 0;
  return (partidos.reduce((a,p)=>a+(p.stats[campo]||0),0) / partidos.length).toFixed(1);
}

window.db = db;
window.getTeamIdByName = getTeamIdByName;
window.getTeamData = getTeamData;
window.promedio = promedio;
