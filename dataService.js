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
 * 🌐 PROXY HELPER & RETRY SYSTEM
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSmart(targetApiUrl) {
  const base64Url = btoa(targetApiUrl);
  // Nota: Aquí usamos las comillas inclinadas ` `
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
 * 🧠 1. OBTENER TEAM ID
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
 * 🧠 2. FUNCIÓN PRINCIPAL (PARTIDOS) - OPTIMIZADA
 *************************************************/
async function getTeamData(teamName, forceUpdate = false) {
  // Cambiamos el orden para priorizar la temporada más actual
  const yearsToCheck = [2024, 2025, 2023]; 
  const docId = teamName.toLowerCase().replace(/\s+/g, '_'); 
  const cacheRef = db.collection("cache_equipos").doc(docId);
  
  if (!forceUpdate) {
    const cache = await cacheRef.get();
    if (cache.exists) {
      const last = cache.data().updated?.toDate();
      // Cache de 6 horas para mayor precisión en ligas activas
      if (last && (Date.now() - last.getTime()) / 36e5 < 6 && cache.data().partidos?.length) {
        return cache.data().partidos;
      }
    }
  }

  const teamId = await getTeamIdByName(teamName);
  if (!teamId) return [];

  let todosLosPartidos = [];

  // Recolectamos partidos de las temporadas relevantes
  for (let year of yearsToCheck) {
    const data = await fetchSmart(`https://v3.football.api-sports.io/fixtures?team=${teamId}&season=${year}`);
    if (data.response && data.response.length > 0) {
        // Filtramos solo los terminados
        const terminados = data.response.filter(p => ['FT','AET','PEN'].includes(p.fixture.status.short));
        todosLosPartidos = todosLosPartidos.concat(terminados);
    }
  }

  if (todosLosPartidos.length === 0) return [];

  // Ordenamos por fecha real de más reciente a más antiguo
  todosLosPartidos.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  
  const ultimos10 = todosLosPartidos.slice(0, 10);
  const partidos = [];

  for (const f of ultimos10) {
    const statData = await fetchSmart(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${f.fixture.id}`);
    
    // IMPORTANTE: Buscamos las estadísticas específicamente de NUESTRO equipo
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    
    const getVal = (name) => {
        if (!statsTeam) return 0;
        const item = statsTeam.statistics.find(x => x.type === name);
        return (item && item.value !== null) ? Number(item.value) : 0;
    };

    // Mejora en la captura de tiros: Sumamos On Goal + Off Goal si Total falla
    let onGoal = getVal("Shots on Goal");
    let offGoal = getVal("Shots off Goal");
    let totalS = getVal("Shots total") || (onGoal + offGoal);

    const isHome = f.teams.home.id === teamId;

    partidos.push({
      fecha: f.fixture.date.split('T')[0], // Limpiamos la fecha para que sea legible (AAAA-MM-DD)
      rival: isHome ? f.teams.away.name : f.teams.home.name,
      local: isHome,
      stats: {
        tt: totalS, 
        tap: onGoal, // Tiros a puerta
        cor: getVal("Corner Kicks"),
        tar: getVal("Yellow Cards") + getVal("Red Cards"),
        gol: isHome ? f.goals.home : f.goals.away
      }
    });

    // Aumentamos ligeramente el wait para no ser bloqueados por la API
    await wait(1000); 
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
/*************************************************
 * 👥 3. JUGADORES CLAVE
 *************************************************/
async function getTopPlayers(teamName) {
    const docId = teamName.toLowerCase().trim().replace(/\s+/g, '_');
    const cacheRef = db.collection("cache_equipos").doc(docId);
    
    const doc = await cacheRef.get();
    if (!doc.exists) return;
    
    const partidos = doc.data().partidos;
    if (!partidos || partidos.length === 0) return;

    // Buscamos el año del partido más reciente para que coincida
    const añoPartidos = new Date(partidos[0].fecha).getFullYear();
    const teamId = await getTeamIdByName(teamName);
    if (!teamId) return;

    const data = await fetchSmart(`https://v3.football.api-sports.io/players?team=${teamId}&season=${añoPartidos}`);

    if (!data.response || data.response.length === 0) {
        const dataPrev = await fetchSmart(`https://v3.football.api-sports.io/players?team=${teamId}&season=${añoPartidos - 1}`);
        if (dataPrev.response) data.response = dataPrev.response;
    }

    const topPlayers = data.response
        .filter(p => p.statistics[0].games.appearences >= 5)
        .map(p => {
            const s = p.statistics[0];
            return {
                nombre: p.player.name,
                foto: p.player.photo,
                posicion: s.games.position,
                rating: s.games.rating ? parseFloat(s.games.rating) : 0,
                goles: s.goals.total || 0,
                asistencias: s.goals.assists || 0
            };
        })
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 5);

    await cacheRef.set({
        jugadores: topPlayers,
        updated: firebase.firestore.Timestamp.now()
    }, { merge: true });

    console.log(`✅ Estrellas de ${teamName} sincronizadas.`);
}
