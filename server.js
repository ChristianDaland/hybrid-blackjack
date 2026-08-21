const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling']
});

// Tvinger alltid fersk versjon uten cache
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

let players = []; 
let dealerHand = [];
let deck = [];
let currentTurnIndex = -1;
let gameStatus = 'WAITING'; // WAITING, BETTING, PLAYING, DEALER_TURN, GAME_OVER

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
    if (['J', 'Q', 'K'].includes(card.value)) score += 10;
    else if (card.value === 'A') { aces += 1; score += 11; }
    else score += parseInt(card.value);
  }
  while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
  return score;
}

function broadcastState() {
  let visibleDealerHand = [...dealerHand];
  if (gameStatus === 'PLAYING' && dealerHand.length > 1) {
    visibleDealerHand = [dealerHand[0], { suit: '?', value: '?' }];
  }

  // Til iPad / Bordskjerm
  io.emit('game_state', {
    players: players.map((p, idx) => ({
      id: p.id,
      name: p.name,
      hand: p.hand,
      score: p.score,
      bet: p.bet,
      status: p.status,
      isCurrentTurn: idx === currentTurnIndex && gameStatus === 'PLAYING'
    })),
    dealerHand: visibleDealerHand,
    dealerScore: (gameStatus === 'PLAYING' || gameStatus === 'BETTING') 
      ? (dealerHand.length > 0 ? calculateScore([dealerHand[0]]) : 0) 
      : calculateScore(dealerHand),
    gameStatus,
    currentTurnPlayer: currentTurnIndex >= 0 && players[currentTurnIndex] ? players[currentTurnIndex].name : null
  });

  // Til Mobilene
  players.forEach((p, idx) => {
    io.to(p.id).emit('player_state', {
      hand: p.hand,
      score: p.score,
      bet: p.bet,
      status: p.status,
      hasBet: p.bet > 0,
      myTurn: idx === currentTurnIndex && gameStatus === 'PLAYING',
      gameStatus,
      canDouble: p.hand.length === 2 && idx === currentTurnIndex && gameStatus === 'PLAYING'
    });
  });
}

function nextTurn() {
  currentTurnIndex++;
  if (currentTurnIndex >= players.length) {
    playDealerTurn();
  } else {
    if (players[currentTurnIndex].score === 21) {
      players[currentTurnIndex].status = 'STAND';
      nextTurn();
    } else {
      players[currentTurnIndex].status = 'PLAYING';
      broadcastState();
    }
  }
}

async function playDealerTurn() {
  gameStatus = 'DEALER_TURN';
  broadcastState();

  while (calculateScore(dealerHand) < 17) {
    await new Promise(r => setTimeout(r, 1200));
    dealerHand.push(deck.pop());
    broadcastState();
  }

  gameStatus = 'GAME_OVER';
  broadcastState();
}

io.on('connection', (socket) => {
  socket.on('join_game', ({ name }) => {
    if (!players.find(p => p.id === socket.id)) {
      players.push({
        id: socket.id,
        name: name || `Spiller ${players.length + 1}`,
        hand: [],
        score: 0,
        bet: 0,
        status: 'WAITING'
      });
    }
    broadcastState();
  });

  // Start budrunde fra iPad
  socket.on('start_game', () => {
    if (players.length === 0) return;

    deck = createDeck();
    dealerHand = [];
    gameStatus = 'BETTING';

    players.forEach(p => {
      p.hand = [];
      p.score = 0;
      p.bet = 0;
      p.status = 'BETTING';
    });

    currentTurnIndex = -1;
    broadcastState();
  });

  // Spiller sender bud
  socket.on('place_bet', ({ amount }) => {
    const player = players.find(p => p.id === socket.id);
    if (player && gameStatus === 'BETTING') {
      player.bet = parseInt(amount) || 10;
      player.status = 'WAITING';

      // Sjekk om ALLE har lagt inn bud
      const allBet = players.every(p => p.bet > 0);
      if (allBet) {
        dealerHand = [deck.pop(), deck.pop()];
        gameStatus = 'PLAYING';
        players.forEach(p => {
          p.hand = [deck.pop(), deck.pop()];
          p.score = calculateScore(p.hand);
        });
        nextTurn();
      } else {
        broadcastState();
      }
    }
  });

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

  socket.on('player_double', () => {
    const player = players[currentTurnIndex];
    if (player && player.id === socket.id && gameStatus === 'PLAYING' && player.hand.length === 2) {
      player.bet *= 2;
      player.hand.push(deck.pop());
      player.score = calculateScore(player.hand);
      player.status = player.score > 21 ? 'BUST' : 'DOUBLED';
      nextTurn();
    }
  });

  socket.on('player_stand', () => {
    const player = players[currentTurnIndex];
    if (player && player.id === socket.id && gameStatus === 'PLAYING') {
      player.status = 'STAND';
      nextTurn();
    }
  });

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
server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));