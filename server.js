const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const path = require('path');

// Server statiske filer fra /public
app.use(express.static(path.join(__dirname, 'public')));

// Hovedskjerm for iPad / PC
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Spillere på mobil
app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

// Global tilstand for spillet
let gameState = {
  phase: 'WAITING', // WAITING, PLAYING, DEALER_TURN, SHOWDOWN
  deck: [],
  dealerHand: [],
  players: [], // Array med { id, name, hand, status: 'PLAYING'|'BUST'|'STAND', score }
  currentTurnIndex: 0,
  winnerInfo: null
};

// Generer og stokker en standard 52-korts kortstokk
function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];

  for (let suit of suits) {
    for (let value of values) {
      deck.push({ suit, value });
    }
  }

  // Fisher-Yates-stokking
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

// Beregner den optimale poengsummen for en hånd
function calculateHandScore(hand) {
  let score = 0;
  let aces = 0;

  for (let card of hand) {
    if (card.value === 'A') {
      aces += 1;
      score += 11;
    } else if (['K', 'Q', 'J'].includes(card.value)) {
      score += 10;
    } else {
      score += parseInt(card.value, 10);
    }
  }

  while (score > 21 && aces > 0) {
    score -= 10;
    aces -= 1;
  }

  return score;
}

// Sender oppdatert offentlig tilstand til iPad (Bordskjerm)
function broadcastState() {
  // Tilpasset dealer-hånd under aktivt spill (skjul kort nr. 2 for spillerne)
  let visibleDealerHand = [...gameState.dealerHand];
  if (gameState.phase === 'PLAYING' && visibleDealerHand.length > 1) {
    visibleDealerHand = [visibleDealerHand[0], { suit: '?', value: '?' }];
  }

  const publicState = {
    phase: gameState.phase,
    dealerHand: visibleDealerHand,
    dealerScore: gameState.phase === 'PLAYING' ? calculateHandScore([visibleDealerHand[0]]) : calculateHandScore(gameState.dealerHand),
    players: gameState.players.map(p => ({
      id: p.id,
      name: p.name,
      hand: p.hand,
      score: p.score,
      status: p.status
    })),
    currentTurnPlayerId: gameState.players[gameState.currentTurnIndex]?.id || null,
    winnerInfo: gameState.winnerInfo
  };

  io.emit('state_update', publicState);
}

// Sender individuelt privat-state til mobilklienter
function sendPlayerStates() {
  gameState.players.forEach(player => {
    io.to(player.id).emit('player_state', {
      myTurn: gameState.phase === 'PLAYING' && gameState.players[gameState.currentTurnIndex]?.id === player.id,
      hand: player.hand,
      score: player.score,
      status: player.status,
      phase: gameState.phase
    });
  });
}

// Sjekker om turen skal gå videre til neste spiller eller til dealeren
function advanceTurn() {
  let allDone = true;

  for (let i = 0; i < gameState.players.length; i++) {
    if (gameState.players[i].status === 'PLAYING') {
      gameState.currentTurnIndex = i;
      allDone = false;
      break;
    }
  }

  if (allDone) {
    runDealerTurn();
  } else {
    broadcastState();
    sendPlayerStates();
  }
}

// Automatisk dealer-sekvens (Banken trekker til 17 eller mer)
function runDealerTurn() {
  gameState.phase = 'DEALER_TURN';
  broadcastState();

  const dealerInterval = setInterval(() => {
    let score = calculateHandScore(gameState.dealerHand);

    if (score < 17) {
      gameState.dealerHand.push(gameState.deck.pop());
      broadcastState();
    } else {
      clearInterval(dealerInterval);
      evaluateShowdown();
    }
  }, 1200); // 1.2 sekunder forsinkelse per kort for å skape spenning på iPad-skjermen
}

// Evaluering av vinnere mot banken
function evaluateShowdown() {
  gameState.phase = 'SHOWDOWN';
  const dealerScore = calculateHandScore(gameState.dealerHand);
  const dealerBust = dealerScore > 21;

  let results = [];

  gameState.players.forEach(p => {
    if (p.status === 'BUST') {
      results.push(`${p.name}: Gikk bust (Tap)`);
    } else if (dealerBust) {
      results.push(`${p.name}: Vant! (Banken gikk bust)`);
    } else if (p.score > dealerScore) {
      results.push(`${p.name}: Vant! (${p.score} vs ${dealerScore})`);
    } else if (p.score < dealerScore) {
      results.push(`${p.name}: Tapte (${p.score} vs ${dealerScore})`);
    } else {
      results.push(`${p.name}: Uavgjort / Push (${p.score})`);
    }
  });

  gameState.winnerInfo = {
    dealerScore: dealerScore,
    dealerBust: dealerBust,
    results: results
  };

  broadcastState();
  sendPlayerStates();
}

// Socket.IO Kommunikasjon
io.on('connection', (socket) => {
  console.log(`Ny tilkobling: ${socket.id}`);

  // Registrer spiller fra mobil
  socket.on('join_game', (data) => {
    const existing = gameState.players.find(p => p.id === socket.id);
    if (!existing) {
      gameState.players.push({
        id: socket.id,
        name: data.name || `Spiller ${gameState.players.length + 1}`,
        hand: [],
        score: 0,
        status: 'PLAYING'
      });
    }
    broadcastState();
    sendPlayerStates();
  });

  // Start ny hånd fra iPad eller mobil
  socket.on('start_new_hand', () => {
    if (gameState.players.length === 0) return;

    gameState.deck = createDeck();
    gameState.dealerHand = [];
    gameState.winnerInfo = null;
    gameState.phase = 'PLAYING';
    gameState.currentTurnIndex = 0;

    // Tilbakestill spillere og del ut 2 startkort hver
    gameState.players.forEach(player => {
      player.hand = [gameState.deck.pop(), gameState.deck.pop()];
      player.score = calculateHandScore(player.hand);
      player.status = player.score === 21 ? 'STAND' : 'PLAYING';
    });

    // Del ut 2 kort til dealer (ett skjules automatisk under PLAYING)
    gameState.dealerHand = [gameState.deck.pop(), gameState.deck.pop()];

    advanceTurn();
  });

  // Handling: Spiller trekker kort ("Hit")
  socket.on('player_hit', () => {
    const currentPlayer = gameState.players[gameState.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id || gameState.phase !== 'PLAYING') return;

    currentPlayer.hand.push(gameState.deck.pop());
    currentPlayer.score = calculateHandScore(currentPlayer.hand);

    if (currentPlayer.score > 21) {
      currentPlayer.status = 'BUST';
      advanceTurn();
    } else if (currentPlayer.score === 21) {
      currentPlayer.status = 'STAND';
      advanceTurn();
    } else {
      broadcastState();
      sendPlayerStates();
    }
  });

  // Handling: Spiller står ("Stand")
  socket.on('player_stand', () => {
    const currentPlayer = gameState.players[gameState.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id || gameState.phase !== 'PLAYING') return;

    currentPlayer.status = 'STAND';
    advanceTurn();
  });

  // Tilbakestill/Nullstill rommet
  socket.on('reset_game', () => {
    gameState.phase = 'WAITING';
    gameState.dealerHand = [];
    gameState.winnerInfo = null;
    gameState.players.forEach(p => {
      p.hand = [];
      p.score = 0;
      p.status = 'PLAYING';
    });
    broadcastState();
    sendPlayerStates();
  });

  // Håndter at spiller kobler fra
  socket.on('disconnect', () => {
    console.log(`Spiller koblet fra: ${socket.id}`);
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    if (gameState.phase === 'PLAYING') {
      advanceTurn();
    } else {
      broadcastState();
      sendPlayerStates();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Blackjack-server kjører på port ${PORT}`);
});