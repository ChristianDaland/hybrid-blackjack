const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Ruter
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

// Spill-tilstand
let players = [];
let deck = [];
let dealerHand = [];
let gameStatus = 'WAITING'; // WAITING, BETTING, PLAYING, GAME_OVER
let currentTurnIndex = 0;

// Kortstokk-funksjoner
function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let newDeck = [];
  for (let s of suits) {
    for (let v of values) {
      newDeck.push({ suit: s, value: v });
    }
  }
  return newDeck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function calculateHand(hand) {
  let score = 0;
  let aces = 0;

  for (let card of hand) {
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

function startBettingPhase() {
  deck = shuffle(createDeck());
  dealerHand = [];
  gameStatus = 'BETTING';
  currentTurnIndex = 0;

  players.forEach(p => {
    p.hand = [];
    p.score = 0;
    p.bet = 0;
    p.hasBet = false;
    p.status = 'WAITING';
  });

  broadcastState();
}

function dealInitialCards() {
  gameStatus = 'PLAYING';

  // Del ut 2 kort til hver spiller
  players.forEach(p => {
    p.hand = [deck.pop(), deck.pop()];
    p.score = calculateHand(p.hand);
    p.status = 'PLAYING';
  });

  // Del ut 2 kort til dealer
  dealerHand = [deck.pop(), deck.pop()];

  currentTurnIndex = 0;
  checkNextTurn();
}

function checkNextTurn() {
  if (currentTurnIndex >= players.length) {
    playDealerTurn();
    return;
  }

  const currentPlayer = players[currentTurnIndex];
  if (currentPlayer.score >= 21) {
    currentTurnIndex++;
    checkNextTurn();
  } else {
    broadcastState();
  }
}

function playDealerTurn() {
  gameStatus = 'GAME_OVER';
  let dealerScore = calculateHand(dealerHand);

  while (dealerScore < 17) {
    dealerHand.push(deck.pop());
    dealerScore = calculateHand(dealerHand);
  }

  broadcastState();
}

function broadcastState() {
  const dealerScore = gameStatus === 'GAME_OVER' 
    ? calculateHand(dealerHand) 
    : (dealerHand.length > 0 ? calculateHand([dealerHand[0]]) : 0);

  // Send felles spilltilstand til storskjermen
  io.emit('game_state', {
    gameStatus,
    dealerHand,
    dealerScore,
    players: players.map((p, index) => ({
      id: p.id,
      name: p.name,
      hand: p.hand,
      score: p.score,
      bet: p.bet,
      hasBet: p.hasBet,
      isCurrentTurn: gameStatus === 'PLAYING' && index === currentTurnIndex
    }))
  });

  // Send individuelt event til hver mobil slik at kort og bud skifter umiddelbart
  players.forEach((p, index) => {
    io.to(p.id).emit('player_state', {
      gameStatus,
      hand: p.hand,
      score: p.score,
      bet: p.bet,
      hasBet: p.hasBet,
      myTurn: gameStatus === 'PLAYING' && index === currentTurnIndex
    });
  });
}

// Socket.io tilkoblinger
io.on('connection', (socket) => {
  console.log('Ny tilkobling:', socket.id);

  socket.on('join_game', (data) => {
    const existingPlayer = players.find(p => p.id === socket.id);
    if (!existingPlayer) {
      players.push({
        id: socket.id,
        name: data.name || 'Anonym',
        hand: [],
        score: 0,
        bet: 0,
        hasBet: false,
        status: 'WAITING'
      });
    }
    broadcastState();
  });

  socket.on('start_new_hand', () => {
    if (players.length > 0) {
      startBettingPhase();
    }
  });

  socket.on('place_bet', (data) => {
    const player = players.find(p => p.id === socket.id);
    if (!player || gameStatus !== 'BETTING') return;

    player.bet = parseInt(data.amount) || 0;
    player.hasBet = true;

    // Sjekk om alle tilkoblede spillere har lagt inn bud
    const allBet = players.every(p => p.hasBet);
    if (allBet) {
      dealInitialCards();
    } else {
      broadcastState();
    }
  });

  socket.on('player_hit', () => {
    if (gameStatus !== 'PLAYING') return;

    const currentPlayer = players[currentTurnIndex];
    if (currentPlayer && currentPlayer.id === socket.id) {
      currentPlayer.hand.push(deck.pop());
      currentPlayer.score = calculateHand(currentPlayer.hand);

      if (currentPlayer.score >= 21) {
        currentTurnIndex++;
        checkNextTurn();
      } else {
        broadcastState();
      }
    }
  });

  socket.on('player_stand', () => {
    if (gameStatus !== 'PLAYING') return;

    const currentPlayer = players[currentTurnIndex];
    if (currentPlayer && currentPlayer.id === socket.id) {
      currentTurnIndex++;
      checkNextTurn();
    }
  });

  socket.on('disconnect', () => {
    console.log('Spiller koblet fra:', socket.id);
    players = players.filter(p => p.id !== socket.id);

    if (players.length === 0) {
      gameStatus = 'WAITING';
    } else if (gameStatus === 'PLAYING') {
      checkNextTurn();
    }

    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server kjører på port ${PORT}`);
});