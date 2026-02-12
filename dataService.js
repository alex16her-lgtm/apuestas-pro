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
window.db = db; // Esto asegura que buscador_api.html vea la base de datos

/*************************************************
 * 🌐 PROXY HELPER & RETRY SYSTEM
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSmart(targetApiUrl) {
  const base64Url = btoa(targetApiUrl);
  const finalProxyUrl = `${WORKER_URL}?base64=${base64Url}`;
  
  let attempts = 0;
  while(attempts < 2) {
      const res = await fetch(finalProxyUrl);
      const data = await res.json();
      if(data.errors && (JSON.stringify(data.errors).includes("requests") || JSON.stringify(data.errors).includes("limit"))) {
          console.warn("⏳ API saturada. Esperando 30s...");
          await wait(30000); 
          attempts++;
          continue;
      }
      return data;
  }
  return { errors: { fatal: "Límite excedido" }, response: [] };
}

/*************************************************
 * 🧠 1. OBTENER TEAM ID (Nombre Limpio)
 *************************************************/
async function getTeamIdByName(teamName){
  const docId = teamName.toLowerCase().replace(/\s+/g, '');
  const cacheIdRef = db.collection("cache_ids").doc(docId);
  const cache = await cacheIdRef.get();

  if(cache.exists) return cache.data().id;

  try {
    const safeName = encodeURIComponent(teamName);
    const data = await fetchSmart(`https://v3.football.api-sports.io/teams?search=${safeName}`);
    if(!data.response || !data.response.length) return null;
    
    const id = data.response[0].team.id;
    await cacheIdRef.set({ id: id, name: teamName });
    return id;
  } catch (e) { return null; }
}

/*************************************************
 * 🧠 2. FUNCIÓN PRINCIPAL (Nombre Limpio)
 *************************************************/
async function getTeamData(teamName, forceUpdate = false){
  const yearsToCheck = [2025, 2024]; 
  const docId = teamName.toLowerCase().replace(/\s+/g, '_'); // ID LIMPIO
  const cacheRef = db.collection("cache_equipos").doc(docId);
  
  if(!forceUpdate){
    const cache = await cacheRef.get();
    if(cache.exists){
      const last = cache.data().updated?.toDate();
      if(last && (Date.now() - last.getTime()) / 36e5 < 12 && cache.data().partidos?.length){
        return cache.data().partidos;
      }
    }
  }

  const teamId = await getTeamIdByName(teamName);
  if(!teamId) return [];

  let fixData = null;
  for (let year of yearsToCheck) {
    const data = await fetchSmart(`https://v3.football.api-sports.io/fixtures?team=${teamId}&season=${year}&status=FT`);
    if(data.response && data.response.length > 0){
        fixData = data;
        break;
    }
  }

  if(!fixData) return [];

  let todos = fixData.response.filter(p => ['FT','AET','PEN'].includes(p.fixture.status.short));
  todos.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  const ultimos10 = todos.slice(0, 10);
  const partidos = [];

  for(const f of ultimos10){
    const statData = await fetchSmart(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${f.fixture.id}`);
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    
    const getVal = (name) => {
        if(!statsTeam) return 0;
        const item = statsTeam.statistics.find(x => x.type === name);
        return (item && item.value !== null) ? Number(item.value) : 0;
    };

    let totalShots = getVal("Shots total") || getVal("Total Shots") || (getVal("Shots on Goal") + getVal("Shots off Goal"));
    const isHome = f.teams.home.id === teamId;

    partidos.push({
      fecha: f.fixture.date,
      rival: isHome ? f.teams.away.name : f.teams.home.name,
      local: isHome,
      stats: {
        tt: totalShots, 
        tap: getVal("Shots on Goal"),
        cor: getVal("Corner Kicks"),
        tar: getVal("Yellow Cards") + getVal("Red Cards"),
        gol: isHome ? f.goals.home : f.goals.away
      }
    });
    await wait(1500); 
  }

  if(partidos.length){
    await cacheRef.set({
      team: teamName,
      partidos: partidos,
      updated: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }
  return partidos;
}

/*************************************************
 * 👥 3. JUGADORES CLAVE (Nombre Limpio)
 *************************************************/
async function getTopPlayers(teamName) {
    const docId = teamName.toLowerCase().trim().replace(/\s+/g, '_');
    const cacheRef = db.collection("cache_equipos").doc(docId);
    
    const doc = await cacheRef.get();
    if (!doc.exists) return;
    
    const partidos = doc.data().partidos;
    if (!partidos || partidos.length === 0) return;

    const añoReciente = new Date(partidos[0].fecha).getFullYear();
    const teamId = await getTeamIdByName(teamName);
    if (!teamId) return;

    // Consultamos la API
    const data = await fetchSmart(`https://v3.football.api-sports.io/players?team=${teamId}&season=${añoReciente}`);

    if (!data.response || data.response.length === 0) {
        console.warn("Intentando con año anterior por falta de datos...");
        const dataPrev = await fetchSmart(`https://v3.football.api-sports.io/players?team=${teamId}&season=${añoReciente - 1}`);
        if (dataPrev.response) data.response = dataPrev.response;
    }

    // 🔥 FILTRADO Y ORDENADO DE ESTRELLAS
    const topPlayers = data.response
        .filter(p => {
            const stats = p.statistics[0];
            // Solo jugadores con más de 5 partidos jugados (evita reservas/juveniles)
            return stats.games.appearences >= 5;
        })
        .map(p => {
            const s = p.statistics[0];
            return {
                nombre: p.player.name,
                foto: p.player.photo,
                posicion: s.games.position,
                // Convertimos el rating a número real para que el sort funcione
                rating: s.games.rating ? parseFloat(s.games.rating) : 0,
                goles: s.goals.total || 0,
                asistencias: s.goals.assists || 0
            };
        })
        // Ordenamos: primero por Rating, luego por Goles (para ver a los goleadores arriba)
        .sort((a, b) => {
            if (b.rating !== a.rating) {
                return b.rating - a.rating;
            }
            return b.goles - a.goles;
        })
        .slice(0, 5); // Los 5 mejores

    if (topPlayers.length === 0) {
        console.error("No se encontraron jugadores que cumplan el filtro de 5 partidos.");
        return [];
    }

    // Guardar en Firebase con la marca de tiempo para refrescar la pantalla
    await cacheRef.set({
        jugadores: topPlayers,
        updated: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`✅ Estrellas de ${teamName} sincronizadas.`);
}
