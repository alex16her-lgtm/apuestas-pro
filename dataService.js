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
 * 🌐 CLOUDFLARE WORKER (PROXY)
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";

/*************************************************
 * 🧠 1. OBTENER TEAM ID
 *************************************************/
async function getTeamIdByName(teamName){
  try {
    const apiUrl = `https://v3.football.api-sports.io/teams?search=${teamName}`;
    const proxyUrl = `${WORKER_URL}?url=${encodeURIComponent(apiUrl)}`;
    
    const res = await fetch(proxyUrl);
    const data = await res.json();

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
 * 🧠 2. OBTENER LISTA DE PARTIDOS (Con Fallback)
 *************************************************/
async function fetchFixtures(teamId, season) {
  // Pedimos la temporada completa, sin filtro "last" para evitar errores
  const apiUrl = `https://v3.football.api-sports.io/fixtures?team=${teamId}&season=${season}&status=FT`;
  const proxyUrl = `${WORKER_URL}?url=${encodeURIComponent(apiUrl)}`;
  
  console.log(`📡 Buscando partidos temporada ${season}...`);
  const res = await fetch(proxyUrl);
  const data = await res.json();
  
  return data.response || [];
}

/*************************************************
 * 🧠 3. FUNCIÓN PRINCIPAL
 *************************************************/
async function getTeamData(teamName){
  console.log(`🚀 Iniciando para: ${teamName}`);

  // --- A. CACHÉ ---
  const cacheRef = db.collection("cache_equipos").doc(`${teamName.replace(/\s+/g, '_')}`);
  const cache = await cacheRef.get();
  if(cache.exists){
    const last = cache.data().updated?.toDate();
    if(last && (Date.now() - last.getTime()) / 36e5 < 12 && cache.data().partidos?.length){
      console.log("📦 Desde Caché");
      return cache.data().partidos;
    }
  }

  if(!(await canMakeRequest())) return [];

  // --- B. BUSCAR ID ---
  const teamId = await getTeamIdByName(teamName);
  if(!teamId) return [];

  // --- C. BUSCAR PARTIDOS (INTENTO 2024 -> INTENTO 2023) ---
  let fixtures = await fetchFixtures(teamId, 2024);
  
  if (fixtures.length === 0) {
    console.warn("⚠️ Temporada 2024 vacía, intentando 2023...");
    fixtures = await fetchFixtures(teamId, 2023);
  }

  if (fixtures.length === 0) {
    console.error("❌ No se encontraron partidos en 2023 ni 2024.");
    return [];
  }

  // --- D. FILTRAR LOS ÚLTIMOS 10 (MANUALMENTE) ---
  // Ordenamos por fecha descendente (el más reciente primero)
  fixtures.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  
  // Tomamos solo los 10 primeros
  const ultimos10 = fixtures.slice(0, 10);
  const partidos = [];

  console.log(`🎫 Procesando estadísticas de ${ultimos10.length} partidos...`);

  // --- E. DETALLE ESTADÍSTICAS ---
  for(const f of ultimos10){
    const statsUrl = `https://v3.football.api-sports.io/fixtures/statistics?fixture=${f.fixture.id}`;
    const proxyUrl = `${WORKER_URL}?url=${encodeURIComponent(statsUrl)}`;
    
    const statRes = await fetch(proxyUrl);
    const statData = await statRes.json();
    
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    if(!statsTeam) continue;

    const getVal = (type) => (statsTeam.statistics.find(x => x.type === type)?.value) || 0;
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

    // Pausa anti-bloqueo
    await new Promise(r => setTimeout(r, 400));
  }

  // --- F. GUARDAR ---
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
