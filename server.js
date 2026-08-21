const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Socket.IO med aktivert WebSocket og CORS
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Tvinger mobiler/nettlesere til ALDRI å lagre gamle filer (fjerner "Trykk og hold"-cache)
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Server statiske filer fra public-mappen
app.use(express.static(path.join(__dirname, 'public')));

// Spilltilstand
let players = []; // { id, name, hand: [], score: 0, status: 'WAITING' | 'PLAYING' | 'BUST' | 'STAND' }
let dealerHand = [];
let deck = [];
let currentTurnIndex = -1;
let gameStatus = 'WAITING'; // WAITING, PLAYING, DEALER_TURN, GAME_OVER

// Kortstokk-funksjoner
function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const newDeck = [];
  for (let suit of suits) {
    for (let value of values) {
      newDeck.push({ suit, value });
    }
  }
  return newDeck.sort(() => Math.random() - 0.5);
}

function calculateScore(hand) {
  let score = 0;
  let aces = 0;

  for (let card of hand) {
    if (card.value === '?') continue;
    if (['J', 'Q', 'K'].includes(card.value)) {
      score += 10;
    } else if (card.value === 'A') {
      aces += 1;
      score += 11;
    } else {
      score += parseInt(card.value);
    }
  }

  while (score > 21 && aces > 0) {
    score -= 10;
    aces -= 1;
  }

  return score;
}

// Sender oppdatert tilstand til alle
function broadcastState() {
  // Til Bordskjerm (iPad)
  let visibleDealerHand = [...dealerHand];
  if (gameStatus === 'PLAYING' && dealerHand.length > 1) {
    visibleDealerHand = [dealerHand[0], { suit: '?', value: '?' }];
  }

  io.emit('game_state', {
    players: players.map((p, idx) => ({
      id: p.id,
      name: p.name,
      hand: p.hand,
      score: p.score,
      status: p.status,
      isCurrentTurn: idx === currentTurnIndex && gameStatus === 'PLAYING'
    })),
    dealerHand: visibleDealerHand,
    dealerScore: gameStatus === 'PLAYING' ? calculateScore([dealerHand[0]]) : calculateScore(dealerHand),
    gameStatus,
    currentTurnPlayer: currentTurnIndex >= 0 && players[currentTurnIndex] ? players[currentTurnIndex].name : null
  });

  // Til hver enkelt mobil
  players.forEach((p, idx) => {
    io.to(p.id).emit('player_state', {
      hand: p.hand,
      score: p.score,
      status: p.status,
      myTurn: idx === currentTurnIndex && gameStatus === 'PLAYING',
      gameStatus
    });
  });
}

function nextTurn() {
  currentTurnIndex++;
  if (currentTurnIndex >= players.length) {
    // Alle spillere ferdige -> Dealer sin tur
    playDealerTurn();
  } else {
    players[currentTurnIndex].status = 'PLAYING';
    broadcastState();
  }
}

async function playDealerTurn() {
  gameStatus = 'DEALER_TURN';
  broadcastState();

  // Trekk for dealer med 1.2 sek forsinkelse per kort
  while (calculateScore(dealerHand) < 17) {
    await new Promise(r => setTimeout(r, 1200));
    dealerHand.push(deck.pop());
    broadcastState();
  }

  gameStatus = 'GAME_OVER';
  broadcastState();
}

io.on('connection', (socket) => {
  console.log('Ny tilkobling:', socket.id);

  // Registrer spiller fra mobil
  socket.on('join_game', ({ name }) => {
    if (!players.find(p => p.id === socket.id)) {
      players.push({
        id: socket.id,
        name: name || `Spiller ${players.length + 1}`,
        hand: [],
        score: 0,
        status: 'WAITING'
      });
    }
    broadcastState();
  });

  // Start nytt spill fra iPad
  socket.on('start_game', () => {
    if (players.length === 0) return;

    deck = createDeck();
    dealerHand = [deck.pop(), deck.pop()];
    gameStatus = 'PLAYING';

    players.forEach(p => {
      p.hand = [deck.pop(), deck.pop()];
      p.score = calculateScore(p.hand);
      p.status = 'WAITING';
    });

    currentTurnIndex = -1;
    nextTurn();
  });

  // Trekk kort (Hit)
  socket.on('player_hit', () => {
    const player = players[currentTurnIndex];
    if (player && player.id === socket.id && gameStatus === 'PLAYING') {
      player.hand.push(deck.pop());
      player.score = calculateScore(player.hand);

      if (player.score > 21) {
        player.status = 'BUST';
        nextTurn();
      } else {
        broadcastState();
      }
    }
  });

  // Stå (Stand)
  socket.on('player_stand', () => {
    const player = players[currentTurnIndex];
    if (player && player.id === socket.id && gameStatus === 'PLAYING') {
      player.status = 'STAND';
      nextTurn();
    }
  });

  // Nullstill alt
  socket.on('reset_game', () => {
    players = [];
    dealerHand = [];
    gameStatus = 'WAITING';
    currentTurnIndex = -1;
    broadcastState();
  });

  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server kjører på port ${PORT}`);
});