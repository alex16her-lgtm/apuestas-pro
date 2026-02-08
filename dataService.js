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

// Inicializar solo si no existe
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const db = firebase.firestore();

// 🔴 ARREGLO 1: Exportar la referencia que busca tu HTML
// Asegúrate de que "analisis_partidos" es el nombre de tu colección en Firebase
window.refAnalisis = db.collection("analisis_partidos"); 

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
 * 🧠 OBTENER TEAM ID
 *************************************************/
async function getTeamIdByName(teamName){
  try {
    const res = await fetch(
      `${WORKER_URL}?url=${encodeURIComponent(`https://v3.football.api-sports.io/teams?search=${teamName}`)}`
    );
    const data = await res.json();
    
    // 🔥 DEBUG: Ver qué responde realmente la API
    console.log("🔍 Respuesta API para " + teamName, data); 

    if (data.errors && Object.keys(data.errors).length > 0) {
        console.error("🚨 ERROR DE API:", data.errors);
        alert("Error de API: " + JSON.stringify(data.errors));
        return null;
    }

    if(!data.response || !data.response.length){
      console.warn("❌ Equipo no encontrado (array vacío):", teamName);
      return null;
    }

    return data.response[0].team.id;
  } catch (e) {
    console.error("Error buscando equipo ID:", e);
    return null;
  }
}
/*************************************************
 * 🧠 OBTENER ÚLTIMOS 10 PARTIDOS (MODO DEPURACIÓN)
 *************************************************/
async function getTeamData(teamName){
  console.log(`🚀 Iniciando búsqueda para: ${teamName}`);

  // 1. Intentar cargar de caché
  const cacheRef = db.collection("cache_equipos").doc(`${teamName.replace(/\s+/g, '_')}`);
  const cache = await cacheRef.get();

  if(cache.exists){
    const last = cache.data().updated?.toDate();
    if(last){
      const diff = (Date.now() - last.getTime()) / 1000 / 60 / 60; 
      if(diff < 12 && cache.data().partidos?.length){
        console.log("📦 Cache usado para:", teamName);
        return cache.data().partidos;
      }
    }
  }

  // 2. Verificar límites locales
  if(!(await canMakeRequest())){
    console.warn("⚠️ Límite diario de API alcanzado (Firebase)");
    return [];
  }

  // 3. Buscar ID del equipo
  const teamId = await getTeamIdByName(teamName);
  if(!teamId) {
    console.error("❌ No se obtuvo ID para el equipo:", teamName);
    return [];
  }
  console.log(`✅ ID encontrado para ${teamName}: ${teamId}`);

  // 4. Buscar Partidos (Fixtures)
  // Nota: encodeURIComponent es VITAL para que el Worker lea bien los símbolos "&"
  const urlFixtures = `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=10&status=FT`;
  console.log("📡 Solicitando partidos...");
  
  const fixRes = await fetch(`${WORKER_URL}?url=${encodeURIComponent(urlFixtures)}`);
  const fixData = await fixRes.json();

  // DEBUG: Ver qué responde la API de partidos
  console.log("🔍 Respuesta Fixtures:", fixData);

  if(!fixData.response || fixData.response.length === 0){
    console.warn("⚠️ La API no devolvió partidos. Posible causa: Fin de temporada o error de API Key en el worker.");
    if(fixData.errors && Object.keys(fixData.errors).length > 0) console.error("API Error:", fixData.errors);
    return [];
  }

  const partidos = [];
  console.log(`🎫 Procesando ${fixData.response.length} partidos...`);

  // 5. Loop para sacar estadísticas (Uno por uno)
  for(const f of fixData.response){
    const fixtureId = f.fixture.id;
    
    // URL Stats
    const urlStats = `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`;
    const statRes = await fetch(`${WORKER_URL}?url=${encodeURIComponent(urlStats)}`);
    const statData = await statRes.json();
    
    // Validar respuesta de stats
    if(!statData.response || statData.response.length === 0){
        console.warn(`⚠️ Sin stats para partido ${fixtureId} (¿Límite de API?)`);
        continue; 
    }

    // Buscar stats de ESTE equipo
    const statsTeam = statData.response.find(s => s.team.id === teamId);
    if(!statsTeam) continue;

    const getStat = (type) => {
        const item = statsTeam.statistics.find(x => x.type === type);
        return item ? (item.value || 0) : 0;
    };

    const isHome = f.teams.home.id === teamId;

    partidos.push({
      fecha: f.fixture.date,
      rival: isHome ? f.teams.away.name : f.teams.home.name,
      local: isHome,
      stats: {
        tt: getStat("Shots total"),
        tap: getStat("Shots on Goal"),
        cor: getStat("Corner Kicks"),
        tar: getStat("Yellow Cards"), 
        gol: isHome ? f.goals.home : f.goals.away
      }
    });
    
    // ⏱️ Pausa de seguridad para no saturar la API (importante en plan free)
    await new Promise(r => setTimeout(r, 500)); 
  }

  console.log(`✅ ${partidos.length} partidos procesados con éxito.`);

  // 6. Guardar en Caché si hay datos
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


/*************************************************
 * 🌍 EXPORTAR AL WINDOW
 *************************************************/
window.db = db;
window.getTeamData = getTeamData;
