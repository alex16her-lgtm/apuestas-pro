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
window.db = db; 

/*************************************************
 * ⚙️ CONFIGURACIÓN SPORTMONKS
 *************************************************/
const SM_TOKEN = "RLAlbBhj6P28HuxsGdZeOzDVGFnjpv5RfB0u6Ut7f3zCfbmIIPqeBieuWMq5"; 
const SM_BASE = "https://api.sportmonks.com/v3/football";

/*************************************************
 * 🌐 PROXY HELPER (CORREGIDO)
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSmart(readyUrl) {
  // 1. Asegurar Token
  let finalUrl = readyUrl;
  if (!finalUrl.includes("api_token=")) {
      finalUrl += (finalUrl.includes("?") ? "&" : "?") + `api_token=${SM_TOKEN}`;
  }

  // 🔴 CORRECCIÓN: YA NO usamos encodeURI aquí. 
  // Asumimos que la URL ya viene lista desde la función anterior.
  
  // 2. Codificar para el Worker (Base64)
  const base64Url = btoa(finalUrl);
  const proxyRequest = `${WORKER_URL}?base64=${base64Url}`;
  
  console.log(`📡 Conectando a: ${finalUrl}`);

  try {
      const res = await fetch(proxyRequest);
      
      if (!res.ok) {
        console.error(`❌ Error HTTP del Proxy: ${res.status}`);
        return null;
      }

      const data = await res.json();
      
      // Diagnóstico de error de API
      if(data.message) {
          if (data.message.includes("No result")) {
             console.warn("⚠️ API: No se encontraron resultados.");
             return null;
          }
          if (data.message.includes("Unauthenticated")) {
             alert("Error: Token inválido.");
             return null;
          }
      }
      
      return data;
  } catch (e) {
      console.error("❌ Error Fetch:", e);
      return null;
  }
}

/*************************************************
 * 🧠 1. BUSCAR EQUIPO
 *************************************************/
async function getTeamIdByName(teamName){
  const docId = teamName.toLowerCase().replace(/\s+/g, '');
  const cacheIdRef = db.collection("cache_ids").doc(docId);
  const cache = await cacheIdRef.get();

  if(cache.exists) return cache.data().id;

  // 🔴 AQUÍ CODIFICAMOS UNA SOLA VEZ
  // encodeURIComponent convierte "Real Madrid" en "Real%20Madrid"
  const safeName = encodeURIComponent(teamName);
  
  const url = `${SM_BASE}/teams/search/${safeName}`;
  
  const response = await fetchSmart(url);
  
  if(!response || !response.data || !response.data.length) {
      alert(`No se encontró el equipo "${teamName}" en Sportmonks.`);
      return null;
  }
  
  const id = response.data[0].id;
  await cacheIdRef.set({ id: id, name: teamName });
  return id;
}

/*************************************************
 * 🧠 2. OBTENER DATOS DE PARTIDOS
 *************************************************/
async function getTeamData(teamName, forceUpdate = false) {
  const docId = teamName.toLowerCase().replace(/\s+/g, '_'); 
  const cacheRef = db.collection("cache_equipos").doc(docId);
  
  if (!forceUpdate) {
    const cache = await cacheRef.get();
    if (cache.exists) {
        const last = cache.data().updated?.toDate();
        if (last && (Date.now() - last.getTime()) / 36e5 < 12) {
            return cache.data().partidos;
        }
    }
  }

  const teamId = await getTeamIdByName(teamName);
  if (!teamId) return [];

  const hoy = new Date().toISOString().split('T')[0];
  const inicio = "2024-01-01"; 

  // URL compleja
  const url = `${SM_BASE}/fixtures/between/${inicio}/${hoy}/${teamId}?include=statistics;participants;scores`;

  const rawData = await fetchSmart(url);
  if (!rawData || !rawData.data) return [];

  let fixtures = rawData.data;
  fixtures.sort((a, b) => new Date(b.starting_at) - new Date(a.starting_at));
  
  const ultimos10 = fixtures.slice(0, 10);
  const partidos = [];

  for (const f of ultimos10) {
    // Buscar mi equipo
    const localPart = f.participants.find(p => p.meta.location === 'home');
    const isHome = localPart && localPart.id === teamId;
    
    // Rival
    const rivalObj = f.participants.find(p => p.id !== teamId);
    const rivalName = rivalObj ? rivalObj.name : "Rival";

    // Goles
    let golLocal = 0, golVisit = 0;
    if (f.scores) {
        const scL = f.scores.find(s => s.description === 'CURRENT' && s.score.participant === 'home');
        const scV = f.scores.find(s => s.description === 'CURRENT' && s.score.participant === 'away');
        if(scL) golLocal = scL.score.goals;
        if(scV) golVisit = scV.score.goals;
    }

    // Estadísticas
    const myStats = f.statistics ? f.statistics.filter(s => s.participant_id === teamId) : [];
    
    const getVal = (typeId) => {
        const st = myStats.find(s => s.type_id === typeId);
        return st ? (st.data?.value || st.value || 0) : 0;
    };

    partidos.push({
      fecha: f.starting_at.split(' ')[0],
      rival: rivalName,
      local: isHome,
      stats: {
        tt: getVal(86), 
        tap: getVal(56), 
        cor: getVal(45), 
        tar: getVal(52) + getVal(53),
        gol: isHome ? golLocal : golVisit
      }
    });
  }

  if (partidos.length) {
    await cacheRef.set({
      team: teamName,
      partidos: partidos,
      updated: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  return partidos;
}

async function getTopPlayers(teamName) {
    alert("Función en mantenimiento.");
}
