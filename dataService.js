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
window.refAnalisis = db.collection("analisis_partidos");

/*************************************************
 * 🔐 CONTROL DE REQUESTS LOCAL
 *************************************************/
const MAX_REQUESTS_DIA = 100;

async function canMakeRequest(){
  const today = new Date().toISOString().slice(0,10);
  const ref = db.collection("api_control").doc(today);
  const doc = await ref.get();
  if(!doc.exists){ await ref.set({ count: 0 }); return true; }
  return doc.data().count < MAX_REQUESTS_DIA;
}

async function registerRequest(){
  const today = new Date().toISOString().slice(0,10);
  const ref = db.collection("api_control").doc(today);
  await ref.update({ count: firebase.firestore.FieldValue.increment(1) });
}

/*************************************************
 * 🌐 PROXY HELPER & RETRY SYSTEM
 *************************************************/
const WORKER_URL = "https://api-football-proxy.alex16her.workers.dev";
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchSmart(targetApiUrl) {
  const base64Url = btoa(targetApiUrl);
  const finalProxyUrl = `${WORKER_URL}?base64=${base64Url}`;
  
  let attempts = 0;
  while(attempts < 2) { // Bajamos a 2 intentos para no eternizar
      const res = await fetch(finalProxyUrl);
      const data = await res.json();

      // Detectar bloqueo de API
      if(data.errors && (JSON.stringify(data.errors).includes("requests") || JSON.stringify(data.errors).includes("limit"))) {
          console.warn(`⏳ API saturada. Esperando 30s... (Intento ${attempts+1})`);
          await wait(30000); 
          attempts++;
          continue;
      }
      return data;
  }
  return { errors: { fatal: "Límite diario excedido o error de conexión" }, response: [] };
}

/*************************************************
 * 🧠 1. OBTENER TEAM ID (¡AHORA CON CACHÉ!)
 *************************************************/
async function getTeamIdByName(teamName){
  // 1. Buscamos en Firebase primero (Ahorra 1 petición)
  const docId = teamName.toLowerCase().replace(/\s+/g, '');
  const cacheIdRef = db.collection("cache_ids").doc(docId);
  const cache = await cacheIdRef.get();

  if(cache.exists){
      console.log(`🆔 ID encontrado en memoria: ${teamName} = ${cache.data().id}`);
      return cache.data().id;
  }

  // 2. Si no existe, preguntamos a la API
  try {
    const safeName = encodeURIComponent(teamName);
    const data = await fetchSmart(`https://v3.football.api-sports.io/teams?search=${safeName}`);
    
    if(data.errors && Object.keys(data.errors).length > 0){
        console.error("🚨 ERROR API:", data.errors);
        if(JSON.stringify(data.errors).includes("limit")){
             alert("⚠️ TU API KEY MURIÓ POR HOY. Crea una nueva cuenta en api-football.");
        }
        return null; 
    }

    if(!data.response || !data.response.length){
      console.warn("❌ Equipo no encontrado:", teamName);
      return null;
    }
    
    const id = data.response[0].team.id;

    // 3. Guardamos el ID para no gastar API la próxima vez
    await cacheIdRef.set({ id: id, name: teamName });
    return id;

  } catch (e) {
    console.error("Error ID:", e);
    return null;
  }
}

/*************************************************
 * 🧠 2. FUNCIÓN PRINCIPAL (V7 - Ahorrador)
 *************************************************/
async function getTeamData(teamName, forceUpdate = false){
  const currentYear = 2025; 
  const yearsToCheck = [2025, 2024]; 

  console.log(`🚀 Iniciando para: ${teamName}`);

  // A. CACHÉ DE PARTIDOS V7
  const cacheKey = `${teamName.replace(/\s+/g, '_')}_v7`;
  const cacheRef = db.collection("cache_equipos").doc(cacheKey);
  
  if(!forceUpdate){
    const cache = await cacheRef.get();
    if(cache.exists){
      const last = cache.data().updated?.toDate();
      // Caché dura 12 horas ahora para ahorrar más
      if(last && (Date.now() - last.getTime()) / 36e5 < 12 && cache.data().partidos?.length){
        console.log("📦 Usando memoria guardada (0 Gasto API)");
        return cache.data().partidos;
      }
    }
  }

  // B. VALIDAR LÍMITES
  if(!(await canMakeRequest())) return [];

  // C. OBTENER ID
  const teamId = await getTeamIdByName(teamName);
  if(!teamId) return [];

  // D. OBTENER PARTIDOS
  let fixData = null;

  for (let year of yearsToCheck) {
    console.log(`🔎 Probando temporada ${year}...`);
    const data = await fetchSmart(`https://v3.football.api-sports.io/fixtures?team=${teamId}&season=${year}&status=FT`);

    if(data.errors && JSON.stringify(data.errors).includes("Free plans")){
        console.error(`🚨 PLAN BLOQUEADO PARA AÑO ${year}`);
        if(year === 2025) alert("⚠️ TU CUENTA NO TIENE ACCESO A 2025/26. Crea una cuenta nueva.");
    }

    if(data.response && data.response.length > 0){
        fixData = data;
        console.log(`✅ Datos encontrados en ${year}`);
        break;
    }
    // Pequeña pausa entre años
    await wait(1000);
  }

  if(!fixData || !fixData.response || !fixData.response.length) {
    console.error("❌ Sin partidos accesibles.");
    return [];
  }

  // E. ORDENAR
  let todos = fixData.response.filter(p => ['FT','AET','PEN'].includes(p.fixture.status.short));
  todos.sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date));
  
  const ultimos10 = todos.slice(0, 10);
  const partidos = [];

  console.log(`🎫 Procesando ${ultimos10.length} partidos...`);

  // F. DETALLE
  for(const f of ultimos10){
    const statData = await fetchSmart(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${f.fixture.id}`);
    const statsTeam = statData.response?.find(s => s.team.id === teamId);
    
    const getVal = (name) => {
        if(!statsTeam) return 0;
        const item = statsTeam.statistics.find(x => x.type === name);
        return (item && item.value !== null) ? Number(item.value) : 0;
    };

    let totalShots = getVal("Shots total") || getVal("Total Shots");
    if (totalShots === 0) totalShots = getVal("Goal Attempts");
    if (totalShots === 0) totalShots = getVal("Shots on Goal") + getVal("Shots off Goal") + getVal("Blocked Shots");

    const isHome = f.teams.home.id === teamId;
    const rivalName = isHome ? f.teams.away.name : f.teams.home.name;

    console.log(`📅 ${f.fixture.date.slice(0,10)} vs ${rivalName} | Tiros: ${totalShots}`);

    partidos.push({
      fecha: f.fixture.date,
      rival: rivalName,
      local: isHome,
      stats: {
        tt: totalShots, 
        tap: getVal("Shots on Goal"),
        cor: getVal("Corner Kicks"),
        tar: getVal("Yellow Cards") + getVal("Red Cards"),
        gol: isHome ? f.goals.home : f.goals.away
      }
    });

    await wait(1500); // Pausa necesaria
  }

  // G. GUARDAR
  if(partidos.length){
    await cacheRef.set({
      team: teamName,
      partidos,
      updated: firebase.firestore.FieldValue.serverTimestamp()
    });
    await registerRequest();
  }

  return partidos;
}

window.db = db;
window.getTeamIdByName = getTeamIdByName;
window.getTeamData = getTeamData;

window.promedio = function(partidos, campo){
  if(!partidos || !partidos.length) return 0;
  return (partidos.reduce((a,p)=>a+(p.stats[campo]||0),0) / partidos.length).toFixed(1);
};
