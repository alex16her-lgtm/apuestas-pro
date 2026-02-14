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
 * 🌐 PROXY HELPER (MODO DIAGNÓSTICO)
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSmart(rawUrl) {
  // 1. LIMPIEZA Y CODIFICACIÓN
  // Quitamos espacios extra al inicio/final
  let cleanUrl = rawUrl.trim();
  
  // Si no tiene token, lo agregamos
  if (!cleanUrl.includes("api_token=")) {
      cleanUrl += (cleanUrl.includes("?") ? "&" : "?") + `api_token=${SM_TOKEN}`;
  }

  // 🔴 IMPORTANTE: Codificamos la URL completa para evitar espacios rotos
  // Esto convierte "Real Madrid" en "Real%20Madrid" automáticamente
  const encodedTarget = encodeURI(cleanUrl);

  // 2. PREPARAR PROXY
  const base64Url = btoa(encodedTarget);
  const proxyRequest = `${WORKER_URL}?base64=${base64Url}`;
  
  console.log(`📡 Intentando conectar a: ${encodedTarget}`);

  try {
      const res = await fetch(proxyRequest);
      
      // Si el proxy falla (Error 500 o 404)
      if (!res.ok) {
        console.error(`❌ Error HTTP del Proxy: ${res.status}`);
        return null;
      }

      const data = await res.json();
      
      // 🕵️ DIAGNÓSTICO: Ver qué respondió exactamente la API
      console.log("📩 Respuesta recibida:", data);

      // Verificación de errores comunes
      if(data.message) {
          console.warn("⚠️ ALERTA API:", data.message);
          if (data.message.includes("Unauthenticated")) {
             alert("Error: Token inválido. Revisa tu suscripción o el código.");
          }
      }
      
      return data;
  } catch (e) {
      console.error("❌ Error Grave en Fetch:", e);
      return null;
  }
}

/*************************************************
 * 🧠 1. BUSCAR EQUIPO (CORREGIDA)
 *************************************************/
async function getTeamIdByName(teamName){
  // Limpieza para ID de Firebase
  const docId = teamName.toLowerCase().replace(/\s+/g, '');
  const cacheIdRef = db.collection("cache_ids").doc(docId);
  const cache = await cacheIdRef.get();

  if(cache.exists) return cache.data().id;

  // 🔴 CORRECCIÓN AQUÍ: Usamos encodeURIComponent para los espacios
  // "Real Madrid" se convertirá en "Real%20Madrid" automáticamente
  const safeName = encodeURIComponent(teamName);
  
  const url = `${SM_BASE}/teams/search/${safeName}`;
  
  console.log("🔍 Buscando en API:", url); // Para ver en consola si la URL sale bien

  const response = await fetchSmart(url);
  
  // Diagnóstico: Si la API devuelve algo raro, lo veremos en consola
  if(!response) {
      console.error("❌ La API no respondió nada (null)");
      return null;
  }
  
  if(!response.data || !response.data.length) {
      console.warn("⚠️ API respondió pero la lista 'data' está vacía:", response);
      alert(`No se encontró el equipo: "${teamName}". Intenta verificar el nombre.`);
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
        // Validación de caché (12 horas)
        const last = cache.data().updated?.toDate();
        if (last && (Date.now() - last.getTime()) / 36e5 < 12 && cache.data().partidos?.length) {
            return cache.data().partidos;
        }
    }
  }

  const teamId = await getTeamIdByName(teamName);
  if (!teamId) return [];

  // Rango: Enero 2024 a Hoy
  const hoy = new Date().toISOString().split('T')[0];
  const inicio = "2024-01-01"; 

  // URL compleja con includes
  const url = `${SM_BASE}/fixtures/between/${inicio}/${hoy}/${teamId}?include=statistics;participants;scores`;

  const rawData = await fetchSmart(url);
  if (!rawData || !rawData.data) return [];

  let fixtures = rawData.data;
  fixtures.sort((a, b) => new Date(b.starting_at) - new Date(a.starting_at));
  
  const ultimos10 = fixtures.slice(0, 10);
  const partidos = [];

  for (const f of ultimos10) {
    // Lógica para detectar local/visitante en estructura Sportmonks v3
    const localPart = f.participants.find(p => p.meta.location === 'home');
    const isHome = localPart && localPart.id === teamId;
    
    // Nombre rival
    const rivalObj = f.participants.find(p => p.id !== teamId);
    const rivalName = rivalObj ? rivalObj.name : "Rival";

    // Goles
    let golLocal = 0, golVisit = 0;
    // Intentar sacar goles de scores (current)
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
        tt: getVal(86),  // Tiros
        tap: getVal(56), // Tiros puerta (varía según liga, a veces es 56, 51 o 86)
        cor: getVal(45), // Corners
        tar: getVal(52) + getVal(53), // Tarjetas
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

// Dummy players
async function getTopPlayers(teamName) {
    alert("Función de jugadores en mantenimiento.");
}
