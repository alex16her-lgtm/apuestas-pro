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
 * 🌐 PROXY HELPER (LA SOLUCIÓN)
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";

// Esta función protege la URL para que no se rompa el '&'
async function fetchFromProxy(targetApiUrl) {
  // 1. Codificamos la URL completa
  const encodedUrl = encodeURIComponent(targetApiUrl);
  
  // 2. Construimos la URL del proxy
  const finalProxyUrl = `${WORKER_URL}?url=${encodedUrl}`;

  console.log(`📡 Llamando al Proxy: ${targetApiUrl}`); // Log para verificar
  
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
 * 🧠 2. FUNCIÓN PRINCIPAL (Simplificada)
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

  // D. OBTENER PARTIDOS (Usamos 'last=5' que es más seguro y rápido)
  // Nota: Al usar la función fetchFromProxy, el '&' viajará seguro.
  const urlFixtures = `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=5&status=FT`;
  
  const fixData = await fetchFromProxy(urlFixtures);

  if(!fixData.response || !fixData.response.length){
    console.warn("⚠️ API devolvió 0 partidos. Respuesta:", fixData);
    // Intento de emergencia: buscar temporada pasada si 'last' falla
    console.log("🔄 Intentando buscar por temporada 2023...");
    const urlBackup = `https://v3.football.api-sports.io/fixtures?team=${teamId}&season=2023&status=FT&last=5`;
    const backupData = await fetchFromProxy(urlBackup);
    
    if(!backupData.response || !backupData.response.length){
        console.error("❌ Definitivamente sin datos.");
        return [];
    }
    fixData.response = backupData.response;
  }

  const partidos = [];
  console.log(`🎫 Procesando ${fixData.response.length} partidos...`);

  // E. DETALLE ESTADÍSTICAS
  for(const f of fixData.response){
    const fixtureId = f.fixture.id;
    
    // Llamada segura al proxy
    const statData = await fetchFromProxy(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`);
    
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
    await new Promise(r => setTimeout(r, 300));
  }

  // F. GUARDAR
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
