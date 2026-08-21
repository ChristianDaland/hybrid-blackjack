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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

let players = [];
let deck = [];
let dealerHand = [];
let gameStatus = 'WAITING'; 
let currentTurnIndex = 0;

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
  });

  broadcastState();
}

function dealInitialCards() {
  gameStatus = 'PLAYING';

  players.forEach(p => {
    p.hand = [deck.pop(), deck.pop()];
    p.score = calculateHand(p.hand);
  });

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

io.on('connection', (socket) => {
  socket.on('join_game', (data) => {
    let player = players.find(p => p.id === socket.id);
    if (!player) {
      player = {
        id: socket.id,
        name: data.name || 'Anonym',
        hand: [],
        score: 0,
        bet: 0,
        hasBet: false
      };
      players.push(player);
    }
    broadcastState();
  });

  socket.on('start_new_hand', () => {
    if (players.length > 0) {
      startBettingPhase();
    }
  });

  socket.on('reset_game', () => {
    players = [];
    dealerHand = [];
    gameStatus = 'WAITING';
    broadcastState();
  });

  socket.on('place_bet', (data) => {
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    player.bet = parseInt(data.amount) || 0;
    player.hasBet = true;

    const allBet = players.length > 0 && players.every(p => p.hasBet);
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