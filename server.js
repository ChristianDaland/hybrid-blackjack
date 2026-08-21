const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/mobile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mobile.html')));

let players = [];
let deck = [];
let dealerHand = [];
let gameStatus = 'WAITING'; // WAITING, BETTING, PLAYING, GAME_OVER
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
      score += parseInt(card.value, 10);
    }
  }
  while (score > 21 && aces > 0) {
    score -= 10;
    aces -= 1;
  }
  return score;
}

function broadcastState() {
  const dealerScore = gameStatus === 'GAME_OVER' 
    ? calculateHand(dealerHand) 
    : (dealerHand.length > 0 ? calculateHand([dealerHand[0]]) : 0);

  // Send til storskjerm
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
      chips: p.chips,
      hasBet: p.hasBet,
      isCurrentTurn: gameStatus === 'PLAYING' && index === currentTurnIndex
    }))
  });

  // Send til hver enkelt mobil
  players.forEach((p, index) => {
    io.to(p.id).emit('player_state', {
      gameStatus,
      hand: p.hand,
      score: p.score,
      bet: p.bet,
      chips: p.chips,
      hasBet: p.hasBet,
      myTurn: gameStatus === 'PLAYING' && index === currentTurnIndex
    });
  });
}

io.on('connection', (socket) => {

  // Spiller blir med
  socket.on('join_game', (data) => {
    let player = players.find(p => p.id === socket.id);
    if (!player) {
      player = {
        id: socket.id,
        name: data.name || 'Spiller',
        hand: [],
        score: 0,
        bet: 0,
        chips: 500,
        hasBet: false
      };
      players.push(player);
    }
    broadcastState();
  });

  // Start ny hånd fra storskjerm
  socket.on('start_new_hand', () => {
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
  });

  // Nullstill bord
  socket.on('reset_game', () => {
    players = [];
    dealerHand = [];
    gameStatus = 'WAITING';
    broadcastState();
  });

  // Plasser bud fra mobil (tillates uansett om status er WAITING eller BETTING)
  socket.on('place_bet', (data) => {
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    let betAmount = parseInt(data.amount, 10) || 50;
    if (betAmount > player.chips) betAmount = player.chips;

    player.bet = betAmount;
    player.chips -= betAmount;
    player.hasBet = true;

    // Hvis alle spillere har lagt inn bud, del ut kort og start spillet
    const allBet = players.length > 0 && players.every(p => p.hasBet);
    if (allBet) {
      if (deck.length < 10) deck = shuffle(createDeck());
      gameStatus = 'PLAYING';
      players.forEach(p => {
        p.hand = [deck.pop(), deck.pop()];
        p.score = calculateHand(p.hand);
      });
      dealerHand = [deck.pop(), deck.pop()];
      currentTurnIndex = 0;
    }

    broadcastState();
  });

  socket.on('player_hit', () => {
    if (gameStatus !== 'PLAYING') return;
    const currentPlayer = players[currentTurnIndex];
    if (currentPlayer && currentPlayer.id === socket.id) {
      currentPlayer.hand.push(deck.pop());
      currentPlayer.score = calculateHand(currentPlayer.hand);
      if (currentPlayer.score >= 21) {
        currentTurnIndex++;
      }
      broadcastState();
    }
  });

  socket.on('player_stand', () => {
    if (gameStatus !== 'PLAYING') return;
    const currentPlayer = players[currentTurnIndex];
    if (currentPlayer && currentPlayer.id === socket.id) {
      currentTurnIndex++;
      broadcastState();
    }
  });

  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));