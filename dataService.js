const firebaseConfig = {
  apiKey: "AIzaSyBtOk-otWrGU7ljda52yhVhSvQKaG3siRM",
  authDomain: "apuestas-analisis.firebaseapp.com",
  projectId: "apuestas-analisis",
  storageBucket: "apuestas-analisis.firebasestorage.app",
  messagingSenderId: "542021066839",
  appId: "1:542021066839:web:bb6a43f578a39d07c68312"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
window.db = db; 

// CONFIGURACIÓN DIRECTA (QUE FUNCIONA)
const API_KEY = "06570858d2500d7565171559ba24fb6a"; 
const API_HOST = "v3.football.api-sports.io"; // <--- OJO AQUÍ
const PROXY_URL = "https://corsproxy.io/?"; 
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSmart(endpoint) {
  const targetUrl = `https://${API_HOST}/${endpoint}`;
  const finalUrl = PROXY_URL + encodeURIComponent(targetUrl);

  console.log(`📡 Buscando (Directa): ${endpoint}`);

  try {
      const res = await fetch(finalUrl, {
          headers: {
              "x-apisports-key": API_KEY // Header correcto para cuenta directa
          }
      });
      if (!res.ok) { console.error(`Error HTTP: ${res.status}`); return null; }
      return await res.json();
  } catch (e) {
      console.error("Error Fetch:", e);
      return null;
  }
}

async function getTeamIdByName(teamName){
  const docId = teamName.toLowerCase().replace(/\s+/g, '');
  const cacheIdRef = db.collection("cache_ids").doc(docId);
  const cache = await cacheIdRef.get();
  if(cache.exists) return cache.data().id;

  const response = await fetchSmart(`teams?search=${teamName}`);
  if(!response || !response.response?.length) {
      alert("Equipo no encontrado"); return null;
  }
  const id = response.response[0].team.id;
  await cacheIdRef.set({ id: id, name: teamName });
  return id;
}

async function getTeamData(teamName, forceUpdate = false) {
  const docId = teamName.toLowerCase().replace(/\s+/g, '_'); 
  const cacheRef = db.collection("cache_equipos").doc(docId);
  
  if (!forceUpdate) {
    const cache = await cacheRef.get();
    if (cache.exists) {
        const last = cache.data().updated?.toDate();
        if (last && (Date.now() - last.getTime()) / 36e5 < 4) return cache.data().partidos;
    }
  }

  const teamId = await getTeamIdByName(teamName);
  if (!teamId) return [];

  // FORZAMOS 2024 (GRATIS)
  const data = await fetchSmart(`fixtures?team=${teamId}&season=2024`);
  
  if (!data || !data.response) return [];
  
  let partidos = [];
  const terminados = data.response.filter(p => ['FT', 'AET', 'PEN'].includes(p.fixture.status.short));
  
  // Procesamos los últimos 5 para que sea rápido
  for (const f of terminados.sort((a,b)=>new Date(b.fixture.date)-new Date(a.fixture.date)).slice(0,5)) {
    const statData = await fetchSmart(`fixtures/statistics?fixture=${f.fixture.id}`);
    const statsTeam = statData?.response?.find(s => s.team.id === teamId);
    const getVal = (n) => {
        const i = statsTeam?.statistics?.find(x => x.type === n);
        return i ? Number(i.value) : 0;
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
    await wait(200);
  }

  if (partidos.length) {
    await cacheRef.set({ team: teamName, partidos, updated: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
  return partidos;
}
// Dummy
async function getTopPlayers(){};
