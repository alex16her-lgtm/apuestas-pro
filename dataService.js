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
 * ⚙️ CONFIGURACIÓN API-FOOTBALL (DIRECTA)
 *************************************************/
// Usamos tu llave original que SÍ conectaba
const API_KEY = "06570858d2500d7565171559ba24fb6a"; 
const API_HOST = "v3.football.api-sports.io";

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
              "x-apisports-key": API_KEY
          }
      });
      
      if (!res.ok) {
        console.error(`Error HTTP: ${res.status}`);
        return null;
      }

      const data = await res.json();
      
      // Chequeo de errores
      if (data.errors && Object.keys(data.errors).length > 0) {
          console.error("⚠️ Error API:", data.errors);
          // Si es error de plan, lo mostramos en alerta
          const errorMsg = JSON.stringify(data.errors);
          if (errorMsg.includes("plan")) {
             console.warn("El año solicitado está bloqueado por el plan gratuito.");
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
 * 🧠 2. OBTENER DATOS (FORZADO A 2024)
 *************************************************/
async function getTeamData(teamName, forceUpdate = false) {
  const docId = teamName.toLowerCase().replace(/\s+/g, '_'); 
  const cacheRef = db.collection("cache_equipos").doc(docId);
  
  if (!forceUpdate) {
    const cache = await cacheRef.get();
    if (cache.exists) {
        const last = cache.data().updated?.toDate();
        if (last && (Date.now() - last.getTime()) / 36e5 < 4 && cache.data().partidos?.length) {
            return cache.data().partidos;
        }
    }
  }

  const teamId = await getTeamIdByName(teamName);
  if (!teamId) return [];

  let todosLosPartidos = [];

  // ✅ SOLUCIÓN FINAL: Solo pedimos 2024 (que es GRATIS y ABIERTO)
  const seasons = [2024]; 

  for (let year of seasons) {
      const data = await fetchSmart(`fixtures?team=${teamId}&season=${year}`);
      
      if (data && data.response && data.response.length > 0) {
          const terminados = data.response.filter(p => 
              ['FT', 'AET', 'PEN'].includes(p.fixture.status.short)
          );
          todosLosPartidos = todosLosPartidos.concat(terminados);
      }
      if (todosLosPartidos.length >= 10) break;
  }

  if (todosLosPartidos.length === 0) {
      alert("No se encontraron partidos en 2024 para este equipo.");
      return [];
  }

  todosLosPartidos.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  const ultimos10 = todosLosPartidos.slice(0, 10);
  const partidos = [];

  for (const f of ultimos10) {
    // Pedir estadísticas detalladas
    const statData = await fetchSmart(`fixtures/statistics?fixture=${f.fixture.id}`);
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
        tar: getVal("Yellow Cards") + getVal("Red Cards"),
        gol: isHome ? f.goals.home : f.goals.away
      }
    });

    await wait(250); // Pausa anti-bloqueo
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
