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

/*************************************************
 * 🔐 CONTROL DE REQUESTS (API FREE)
 *************************************************/
const MAX_REQUESTS_DIA = 100;

async function canMakeRequest(){
  const today = new Date().toISOString().slice(0,10);
  const ref = db.collection("api_control").doc(today);
  const doc = await ref.get();

  if(!doc.exists){
    await ref.set({ count: 0 });
    return true;
  }
  return doc.data().count < MAX_REQUESTS_DIA;
}

async function registerRequest(){
  const today = new Date().toISOString().slice(0,10);
  const ref = db.collection("api_control").doc(today);
  await ref.update({
    count: firebase.firestore.FieldValue.increment(1)
  });
}

/*************************************************
 * 🌐 CLOUDFLARE WORKER (PROXY)
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";

/*************************************************
 * 🧠 OBTENER TEAM ID POR NOMBRE
 *************************************************/
async function getTeamIdByName(teamName){
  const res = await fetch(
    `${WORKER_URL}?url=https://v3.football.api-sports.io/teams?search=${encodeURIComponent(teamName)}`
  );

  const data = await res.json();

  if(!data.response || !data.response.length){
    console.warn("❌ Equipo no encontrado:", teamName);
    return null;
  }

  return data.response[0].team.id;
}

/*************************************************
 * 🧠 OBTENER ÚLTIMOS 10 PARTIDOS DE UN EQUIPO
 *************************************************/
async function getTeamData(teamName, leagueId){
  const cacheRef = db.collection("cache_equipos").doc(`${teamName}_${leagueId}`);
  const cache = await cacheRef.get();

  // 🟢 Cache válido 12h
  if(cache.exists){
    const last = cache.data().updated?.toDate();
    if(last){
      const diff = (Date.now() - last.getTime()) / 1000 / 60 / 60;
      if(diff < 12 && cache.data().partidos?.length){
        console.log("📦 Cache usado:", teamName);
        return cache.data().partidos;
      }
    }
  }

  if(!(await canMakeRequest())){
    alert("⚠️ Límite diario de API alcanzado");
    return [];
  }

  const teamId = await getTeamIdByName(teamName);
  if(!teamId) return [];

  const fixRes = await fetch(
    `${WORKER_URL}?url=https://v3.football.api-sports.io/fixtures?team=${teamId}&league=${leagueId}&last=10&status=FT`
  );

  const fixData = await fixRes.json();
  if(!fixData.response?.length){
    console.warn("⚠️ Sin partidos para", teamName);
    return [];
  }

  const partidos = [];

  for(const f of fixData.response){
    const statRes = await fetch(
      `${WORKER_URL}?url=https://v3.football.api-sports.io/fixtures/statistics?fixture=${f.fixture.id}`
    );

    const statData = await statRes.json();
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    if(!statsTeam) continue;

    const isHome = f.teams.home.id === teamId;

    partidos.push({
      fecha: f.fixture.date,
      rival: isHome ? f.teams.away.name : f.teams.home.name,
      local: isHome,
      goles: isHome ? f.goals.home : f.goals.away,
      stats:{
        shotsTotal: statsTeam.statistics.find(x=>x.type==="Shots total")?.value ?? 0,
        shotsOnGoal: statsTeam.statistics.find(x=>x.type==="Shots on Goal")?.value ?? 0,
        corners: statsTeam.statistics.find(x=>x.type==="Corner Kicks")?.value ?? 0,
        yellow: statsTeam.statistics.find(x=>x.type==="Yellow Cards")?.value ?? 0
      }
    });
  }

  if(partidos.length){
    await cacheRef.set({
      team: teamName,
      league: leagueId,
      partidos,
      updated: firebase.firestore.FieldValue.serverTimestamp()
    });
    await registerRequest();
  }

  return partidos;
}

/*************************************************
 * 📊 UTILIDADES
 *************************************************/
function promedio(partidos, campo){
  if(!partidos.length) return 0;
  return (
    partidos.reduce((a,p)=>a+(p.stats[campo]||0),0) / partidos.length
  ).toFixed(1);
}

function probabilidadOver(partidos, campo, linea){
  if(!partidos.length) return { pct:0, pick:"-" };

  const over = partidos.filter(p => (p.stats[campo]||0) > linea).length;
  const pct = Math.round((over / partidos.length) * 100);

  return {
    pct,
    pick: pct >= 50 ? `OVER ${linea}` : `UNDER ${linea}`
  };
}

/*************************************************
 * 🌍 EXPORTAR AL NAVEGADOR
 *************************************************/
window.db = db;
window.getTeamIdByName = getTeamIdByName;
window.getTeamData = getTeamData;
window.promedio = promedio;
window.probabilidadOver = probabilidadOver;
