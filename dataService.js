/*************************************************
 * 🔥 FIREBASE CONFIG (SE MANTIENE IGUAL)
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
 * 🌐 PROXY HELPER (IGUAL PERO ADAPTADO)
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSmart(targetUrl) {
  // Sportmonks pasa el token en la URL, así que nos aseguramos de que esté
  let finalTarget = targetUrl;
  if (!targetUrl.includes("api_token=")) {
      finalTarget += (targetUrl.includes("?") ? "&" : "?") + `api_token=${SM_TOKEN}`;
  }

  const base64Url = btoa(finalTarget);
  const proxyUrl = `${WORKER_URL}?base64=${base64Url}`;
  
  let attempts = 0;
  while(attempts < 2) {
      try {
          const res = await fetch(proxyUrl);
          const data = await res.json();
          
          // Sportmonks a veces devuelve error en el cuerpo
          if(data.message && data.message.includes("Unauthenticated")) {
              console.error("❌ Error de Token: Revisa tu API KEY");
              return null;
          }
          
          // Si nos pasamos del límite (Rate Limit)
          if(res.status === 429) {
             console.warn("⏳ Límite alcanzado, esperando 5s...");
             await wait(5000);
             attempts++;
             continue;
          }
          return data;
      } catch (e) {
          console.error("Error Fetch:", e);
          return null;
      }
  }
  return { data: [] };
}

/*************************************************
 * 🧠 1. OBTENER TEAM ID (VERSIÓN SPORTMONKS)
 *************************************************/
async function getTeamIdByName(teamName){
  // Normalizamos el nombre para usarlo como ID del documento en caché
  const docId = teamName.toLowerCase().replace(/\s+/g, '');
  const cacheIdRef = db.collection("cache_ids").doc(docId);
  const cache = await cacheIdRef.get();

  if(cache.exists) return cache.data().id;

  try {
    const safeName = encodeURIComponent(teamName);
    // Sportmonks búsqueda
    const url = `${SM_BASE}/teams/search/${safeName}`;
    const response = await fetchSmart(url);
    
    if(!response || !response.data || !response.data.length) return null;
    
    // Tomamos el primer resultado
    const id = response.data[0].id;
    await cacheIdRef.set({ id: id, name: teamName });
    return id;
  } catch (e) { 
      console.error(e);
      return null; 
  }
}

/*************************************************
 * 🧠 2. FUNCIÓN PRINCIPAL (PARTIDOS)
 *************************************************/
async function getTeamData(teamName, forceUpdate = false) {
  const docId = teamName.toLowerCase().replace(/\s+/g, '_'); 
  const cacheRef = db.collection("cache_equipos").doc(docId);
  
  // 1. Revisar Caché (si no forzamos actualización)
  if (!forceUpdate) {
    const cache = await cacheRef.get();
    if (cache.exists) {
      const last = cache.data().updated?.toDate();
      // Caché válida por 6 horas
      if (last && (Date.now() - last.getTime()) / 36e5 < 6 && cache.data().partidos?.length) {
        return cache.data().partidos;
      }
    }
  }

  // 2. Obtener ID
  const teamId = await getTeamIdByName(teamName);
  if (!teamId) {
      alert("No se encontró el equipo en Sportmonks");
      return [];
  }

  // 3. Definir rango de fechas (Últimos 2 años para asegurar datos)
  // Formato: YYYY-MM-DD
  const hoy = new Date().toISOString().split('T')[0];
  const inicio = "2024-01-01"; // Ajusta esto si quieres ir más atrás

  // URL Sportmonks: Fixtures entre fechas + Includes (Estadísticas, Participantes, Scores)
  const url = `${SM_BASE}/fixtures/between/${inicio}/${hoy}/${teamId}?include=statistics;participants;scores;league`;

  const rawData = await fetchSmart(url);
  
  if (!rawData || !rawData.data || rawData.data.length === 0) return [];

  let fixtures = rawData.data;

  // Ordenar por fecha (más reciente primero)
  fixtures.sort((a, b) => new Date(b.starting_at) - new Date(a.starting_at));
  
  // Tomamos los últimos 10
  const ultimos10 = fixtures.slice(0, 10);
  const partidos = [];

  for (const f of ultimos10) {
    // Identificar si somos Local o Visitante
    // En Sportmonks participants suele traer 2 objetos. Buscamos el nuestro.
    const metaLocal = f.participants.find(p => p.id === teamId && p.meta.location === 'home');
    const isHome = !!metaLocal; // true si encontramos meta 'home' con nuestro ID

    // Nombre del rival
    const rivalObj = f.participants.find(p => p.id !== teamId);
    const rivalName = rivalObj ? rivalObj.name : "Desconocido";

    // Goles (scores)
    const golesLocal = f.scores.find(s => s.description === 'CURRENT' && s.score.participant === 'home')?.score.goals || 0;
    const golesVisit = f.scores.find(s => s.description === 'CURRENT' && s.score.participant === 'away')?.score.goals || 0;
    
    // ESTADÍSTICAS
    // Sportmonks devuelve un array "statistics". Debemos filtrar las de NUESTRO equipo.
    // OJO: A veces viene vacío si el partido es muy reciente o de liga menor.
    const myStats = f.statistics ? f.statistics.filter(s => s.participant_id === teamId) : [];
    
    // Función auxiliar para buscar por type_id
    // 86: Tiros Totales, 51: Tiros a puerta, 45: Corners, 52: Amarillas, 34: Faltas (ejemplo)
    const getVal = (typeId) => {
        if (!myStats.length) return 0;
        // Sportmonks a veces anida en "details" o pone el type_id directo en el objeto
        // Revisamos estructura común v3:
        const stat = myStats.find(s => s.type_id === typeId);
        return stat ? stat.data.value : 0; 
    };

    // NOTA: Si Sportmonks devuelve estructura distinta en tu plan, 
    // podrías necesitar inspeccionar "f.statistics" en consola.
    
    partidos.push({
      fecha: f.starting_at.split(' ')[0],
      rival: rivalName,
      local: isHome,
      stats: {
        tt: getVal(86), // Tiros Totales
        tap: getVal(51), // Tiros a Puerta (Shot on Target)
        cor: getVal(45), // Corners
        tar: getVal(52) + getVal(53), // Amarillas (52) + Rojas (53)
        gol: isHome ? (f.scores[0]?.score?.goals || 0) : (f.scores[1]?.score?.goals || 0) // Fallback simple de goles
        // Mejor usamos los goles calculados arriba si la estructura scores es compleja
        // gol: isHome ? golesLocal : golesVisit
      }
    });
  }

  // Guardar en Firebase
  if (partidos.length) {
    await cacheRef.set({
      team: teamName,
      partidos: partidos,
      updated: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  return partidos;
}

/*************************************************
 * 👥 3. JUGADORES (HOLDER SIMPLE)
 *************************************************/
// Nota: La API de jugadores en Sportmonks es más compleja y consume más créditos.
// Por ahora dejamos esto simplificado para que no rompa el código.
async function getTopPlayers(teamName) {
    console.log("Función de jugadores pendiente de migración a Sportmonks ID");
    alert("La función de jugadores se está actualizando para la nueva API.");
}
