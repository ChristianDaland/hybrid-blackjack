const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile.html'));
});

let players = [];
let dealerHand = [];
let currentTurnIndex = 0;
let gameStatus = 'WAITING'; // WAITING, BETTING, PLAYING, GAME_OVER

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (let suit of suits) {
    for (let value of values) {
      deck.push({ suit, value });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

let deck = createDeck();

function getCardValue(card) {
  if (['J', 'Q', 'K'].includes(card.value)) return 10;
  if (card.value === 'A') return 11;
  return parseInt(card.value);
}

function calculateScore(hand) {
  let score = 0;
  let aces = 0;
  for (let card of hand) {
    if (card.value === '?') continue;
    score += getCardValue(card);
    if (card.value === 'A') aces++;
  }
  while (score > 21 && aces > 0) {
    score -= 10;
    aces--;
  }
  return score;
}

function broadcastState() {
  const visibleDealerHand = (gameStatus === 'PLAYING') 
    ? [dealerHand[0], { suit: '?', value: '?' }] 
    : dealerHand;

  const gameState = {
    dealerHand: visibleDealerHand,
    dealerScore: calculateScore(visibleDealerHand),
    gameStatus,
    players: players.map((p, index) => ({
      id: p.id,
      name: p.name,
      hand: p.hand,
      score: calculateScore(p.hand),
      bet: p.bet,
      hasBet: p.hasBet,
      isCurrentTurn: index === currentTurnIndex && gameStatus === 'PLAYING',
      status: p.status
    }))
  };

  io.emit('game_state', gameState);

  players.forEach((p, index) => {
    io.to(p.id).emit('player_state', {
      hand: p.hand,
      score: calculateScore(p.hand),
      bet: p.bet,
      hasBet: p.hasBet,
      myTurn: index === currentTurnIndex && gameStatus === 'PLAYING',
      gameStatus
    });
  });
}

function checkAllBetsPlaced() {
  if (players.length > 0 && players.every(p => p.hasBet)) {
    // Alle har bydd – start utdeling!
    gameStatus = 'PLAYING';
    
    // Del ut 2 kort til hver
    players.forEach(p => {
      p.hand = [deck.pop(), deck.pop()];
      p.status = 'PLAYING';
    });

    dealerHand = [deck.pop(), deck.pop()];
    currentTurnIndex = 0;
    broadcastState();
  }
}

io.on('connection', (socket) => {
  socket.on('join_game', (data) => {
    const existing = players.find(p => p.id === socket.id);
    if (!existing) {
      players.push({
        id: socket.id,
        name: data.name,
        hand: [],
        bet: 0,
        hasBet: false,
        status: 'WAITING'
      });
    }
    broadcastState();
  });

  socket.on('start_game', () => {
    if (players.length === 0) return;
    deck = createDeck();
    dealerHand = [];
    currentTurnIndex = 0;
    gameStatus = 'BETTING';

    players.forEach(p => {
      p.hand = [];
      p.bet = 0;
      p.hasBet = false;
      p.status = 'BETTING';
    });

    broadcastState();
  });

  socket.on('place_bet', (data) => {
    const player = players.find(p => p.id === socket.id);
    if (player && gameStatus === 'BETTING') {
      player.bet = parseInt(data.amount) || 0;
      player.hasBet = true;
      broadcastState();
      checkAllBetsPlaced();
    }
  });

  socket.on('player_hit', () => {
    if (gameStatus !== 'PLAYING') return;
    const player = players[currentTurnIndex];
    if (player && player.id === socket.id) {
      player.hand.push(deck.pop());
      if (calculateScore(player.hand) > 21) {
        player.status = 'BUST';
        nextTurn();
      } else {
        broadcastState();
      }
    }
  });

  socket.on('player_stand', () => {
    if (gameStatus !== 'PLAYING') return;
    const player = players[currentTurnIndex];
    if (player && player.id === socket.id) {
      player.status = 'STAND';
      nextTurn();
    }
  });

  socket.on('reset_game', () => {
    players = [];
    dealerHand = [];
    gameStatus = 'WAITING';
    currentTurnIndex = 0;
    broadcastState();
  });

  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    broadcastState();
  });
});

function nextTurn() {
  currentTurnIndex++;
  if (currentTurnIndex >= players.length) {
    playDealer();
  } else {
    broadcastState();
  }
}

function playDealer() {
  while (calculateScore(dealerHand) < 17) {
    dealerHand.push(deck.pop());
  }
  gameStatus = 'GAME_OVER';
  broadcastState();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));