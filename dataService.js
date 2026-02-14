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
 * ⚙️ CONFIGURACIÓN API-FOOTBALL (La Original)
 *************************************************/

const API_KEY = "1e695a5969msh316e6c73834414ap188cf9jsn99ecb518766d"; 

// 🔴 CAMBIO IMPORTANTE: El Host de RapidAPI es diferente
const API_HOST = "api-football-v1.p.rapidapi.com";

/*************************************************
 * 🌐 PROXY HELPER
 *************************************************/
const PROXY_URL = "https://corsproxy.io/?"; 

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSmart(endpoint) {
  const targetUrl = `https://${API_HOST}/${endpoint}`;
  const encodedUrl = encodeURIComponent(targetUrl);
  const finalUrl = PROXY_URL + encodedUrl;

  console.log(`📡 Buscando: ${endpoint}`);

  try {
      const res = await fetch(finalUrl, {
          headers: {
              "x-apisports-key": API_KEY,
              "x-rapidapi-host": API_HOST
          }
      });
      
      if (!res.ok) {
        console.error(`Error HTTP: ${res.status}`);
        return null;
      }

      const data = await res.json();
      
      // Chequeo de errores de API-Football
      if (data.errors && Object.keys(data.errors).length > 0) {
          console.error("⚠️ Error API:", data.errors);
          if (JSON.stringify(data.errors).includes("requests")) {
              alert("Límite diario de API excedido (100 peticiones).");
          }
          return null;
      }
      
      return data;
  } catch (e) {
      console.error("Error Fetch:", e);
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

  // Buscamos en la API
  const response = await fetchSmart(`teams?search=${teamName}`);
  
  if(!response || !response.response || !response.response.length) {
      alert(`No se encontró el equipo: ${teamName}`);
      return null;
  }
  
  const id = response.response[0].team.id;
  await cacheIdRef.set({ id: id, name: teamName });
  return id;
}

/*************************************************
 * 🧠 2. OBTENER DATOS (LÓGICA 2026 MEJORADA)
 *************************************************/
async function getTeamData(teamName, forceUpdate = false) {
  const docId = teamName.toLowerCase().replace(/\s+/g, '_'); 
  const cacheRef = db.collection("cache_equipos").doc(docId);
  
  if (!forceUpdate) {
    const cache = await cacheRef.get();
    if (cache.exists) {
        const last = cache.data().updated?.toDate();
        // Caché de 4 horas para tener datos frescos de partidos de hoy
        if (last && (Date.now() - last.getTime()) / 36e5 < 4 && cache.data().partidos?.length) {
            return cache.data().partidos;
        }
    }
  }

  const teamId = await getTeamIdByName(teamName);
  if (!teamId) return [];

  let todosLosPartidos = [];

  // 🔄 ESTRATEGIA: Buscar primero 2026, luego 2025
  const seasons = [2026, 2025]; 

  for (let year of seasons) {
      // Pedimos partidos de la temporada
      const data = await fetchSmart(`fixtures?team=${teamId}&season=${year}`);
      
      if (data && data.response && data.response.length > 0) {
          // Filtramos solo los terminados (FT, AET, PEN)
          const terminados = data.response.filter(p => 
              ['FT', 'AET', 'PEN'].includes(p.fixture.status.short)
          );
          todosLosPartidos = todosLosPartidos.concat(terminados);
      }
      // Si ya tenemos suficientes partidos (ej: más de 5) con 2026, no pedimos 2025 para ahorrar API
      if (todosLosPartidos.length >= 10) break;
  }

  if (todosLosPartidos.length === 0) return [];

  // Ordenar por fecha (más reciente arriba)
  todosLosPartidos.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  
  const ultimos10 = todosLosPartidos.slice(0, 10);
  const partidos = [];

  for (const f of ultimos10) {
    // Pedir estadísticas de CADA partido
    // OJO: API-Football requiere una llamada extra por partido para stats detalladas
    const statData = await fetchSmart(`fixtures/statistics?fixture=${f.fixture.id}`);
    
    // Buscar mis stats en el array
    const statsTeam = statData?.response?.find(s => s.team.id === teamId);
    
    const getVal = (name) => {
        if (!statsTeam) return 0;
        const item = statsTeam.statistics.find(x => x.type === name);
        return (item && item.value !== null) ? Number(item.value) : 0;
    };

    const isHome = f.teams.home.id === teamId;

    partidos.push({
      fecha: f.fixture.date.split('T')[0],
      rival: isHome ? f.teams.away.name : f.teams.home.name,
      local: isHome,
      stats: {
        tt: getVal("Shots total") || (getVal("Shots on Goal") + getVal("Shots off Goal")), 
        tap: getVal("Shots on Goal"), 
        cor: getVal("Corner Kicks"),
        tar: getVal("Yellow Cards") + getVal("Red Cards"), // Sumamos rojas y amarillas
        gol: isHome ? f.goals.home : f.goals.away
      }
    });

    // Pequeña pausa para no saturar
    await wait(300); 
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
