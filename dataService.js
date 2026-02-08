// ===============================
// 🔥 FIREBASE CONFIG
// ===============================
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

// ===============================
// 🔐 CONTROL DE REQUESTS (FREE)
// ===============================
const MAX_REQUESTS_DIA = 100; // API-Football Free

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
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";


// ===============================
// 🧠 CACHE DE EQUIPOS (FIREBASE)
// ===============================
async function getTeamData(teamName, leagueId){
  const cacheRef = db.collection("cache_equipos").doc(`${teamName}_${leagueId}`);
  const cache = await cacheRef.get();

  // ⏳ cache válido 12h
  if(cache.exists){
    const last = cache.data().updated?.toDate();
    const diff = (Date.now() - last.getTime()) / 1000 / 60 / 60;
    if(diff < 12){
      console.log("📦 Cache usado:", teamName);
      return cache.data().partidos;
    }
  }

  // 🔒 Control requests
  const allowed = await canMakeRequest();
  if(!allowed){
    alert("⚠️ Límite diario de API alcanzado");
    return cache.exists ? cache.data().partidos : [];
  }

  // 🌍 Llamada API
  const partidos = await fetchTeamFromApi(teamName, leagueId);

  await cacheRef.set({
    team: teamName,
    league: leagueId,
    partidos,
    updated: firebase.firestore.FieldValue.serverTimestamp()
  });

  await registerRequest();

  return partidos;
  
  if (!partidos.length) {
  console.warn("⚠️ No se guarda cache vacío");
  return [];
}

}

// ===============================
// 📡 FETCH API-FOOTBALL
// ===============================

async function fetchTeamFromApi(teamName, leagueId){
  try{
    // 1️⃣ Buscar equipo
    const teamRes = await fetch(
      `${WORKER_URL}/?url=https://v3.football.api-sports.io/teams?search=${encodeURIComponent(teamName)}`
    );
    const teamData = await teamRes.json();
    if(!teamData.response?.length) return [];

    const teamId = teamData.response[0].team.id;

    // 2️⃣ Últimos 10 partidos
    const fixRes = await fetch(
      `${WORKER_URL}/?url=https://v3.football.api-sports.io/fixtures?team=${teamId}&league=${leagueId}&last=10`
    );
    const fixData = await fixRes.json();
    if(!fixData.response?.length) return [];

    console.log("📊 FIXTURES RAW:", fixData.response);

    return fixData.response
      .map(f => {
        const isHome = f.teams.home.id === teamId;

        const statsTeam = f.statistics?.find(
          s => s.team.id === teamId
        );
        if (!statsTeam) return null;

        return {
          fecha: f.fixture.date,
          rival: isHome ? f.teams.away.name : f.teams.home.name,
          local: isHome,
          stats:{
            tt: statsTeam.statistics.find(x=>x.type==="Shots total")?.value ?? 0,
            tap: statsTeam.statistics.find(x=>x.type==="Shots on Goal")?.value ?? 0,
            cor: statsTeam.statistics.find(x=>x.type==="Corner Kicks")?.value ?? 0,
            tar: statsTeam.statistics.find(x=>x.type==="Yellow Cards")?.value ?? 0,
            gol: isHome ? f.goals.home : f.goals.away
          }
        };
      })
      .filter(Boolean);

  }catch(e){
    console.error("❌ API error", e);
    return [];
  }
}


// ===============================
// 🧮 UTILIDADES
// ===============================
function promedio(partidos, stat){
  if(!partidos.length) return 0;
  return (
    partidos.reduce((a,p)=>a+(p.stats[stat]||0),0) / partidos.length
  ).toFixed(1);
}

function probabilidadOver(partidos, stat, linea){
  if(!partidos.length) return { pct:0, pick:"-" };

  let over=0;
  partidos.forEach(p=>{
    if((p.stats[stat]||0) > linea) over++;
  });

  const pct = Math.round((over/partidos.length)*100);
  return {
    pct,
    pick: pct>=50 ? `OVER ${linea}` : `UNDER ${linea}`
  };
}
// ===============================
// 🌍 EXPORTAR FIRESTORE GLOBAL
// ===============================
window.db = firebase.firestore();
window.refAnalisis = window.db.collection("analisis");
