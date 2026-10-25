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
let nextHandTimer = null;

// Hvor lenge resultatet vises før neste runde starter automatisk
const NEXT_HAND_DELAY_MS = 8000;

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

function finishDealerTurn() {
  let dealerScore = calculateHand(dealerHand);
  
  // Dealer trekker kun dersom det er minst én aktiv spiller igjen
  const activePlayers = players.filter(p => p.chips > 0 || p.bet > 0);
  if (activePlayers.length > 0) {
    while (dealerScore < 17) {
      dealerHand.push(deck.pop());
      dealerScore = calculateHand(dealerHand);
    }
  }

  gameStatus = 'GAME_OVER';
  scheduleNextHand();

  players.forEach(p => {
    if (p.chips === 0 && p.bet === 0) {
      p.resultText = 'SLÅTT UT';
      return;
    }

    // Ble med midt i runden og har ikke satset
    if (p.bet === 0) return;

    if (p.score > 21) {
      p.resultText = 'Bust (Tapt)';
    } else if (dealerScore > 21) {
      p.resultText = 'VANT! (Banken gikk over)';
      p.chips += p.bet * 2;
    } else if (p.score > dealerScore) {
      p.resultText = 'VANT!';
      p.chips += p.bet * 2;
    } else if (p.score === dealerScore) {
      p.resultText = 'Uavgjort (Push)';
      p.chips += p.bet;
    } else {
      p.resultText = 'Tapt';
    }
  });

  broadcastState();
}

// Hopp over spillere uten innsats (slått ut eller ble med midt i runden) og spillere som allerede har 21
function skipInactivePlayers() {
  while (currentTurnIndex < players.length && (players[currentTurnIndex].bet === 0 || players[currentTurnIndex].score >= 21)) {
    currentTurnIndex++;
  }
}

function dealCards() {
  if (deck.length < 10) deck = shuffle(createDeck());
  gameStatus = 'PLAYING';

  players.forEach(p => {
    if (p.bet > 0) {
      p.hand = [deck.pop(), deck.pop()];
      p.score = calculateHand(p.hand);
    }
  });

  dealerHand = [deck.pop(), deck.pop()];

  // Sett tur til første aktive spiller
  currentTurnIndex = 0;
  skipInactivePlayers();

  if (currentTurnIndex >= players.length) {
    finishDealerTurn();
  } else {
    broadcastState();
  }
}

function allActiveHaveBet() {
  const activePlayers = players.filter(p => p.chips > 0 || p.bet > 0);
  return activePlayers.length > 0 && activePlayers.every(p => p.hasBet);
}

function startNewHand() {
  clearTimeout(nextHandTimer);
  nextHandTimer = null;

  deck = shuffle(createDeck());
  dealerHand = [];
  gameStatus = 'BETTING';

  players.forEach(p => {
    p.hand = [];
    p.score = 0;
    p.bet = 0;
    p.hasBet = false;
    p.resultText = '';
  });

  // Finn første aktive spiller
  currentTurnIndex = players.findIndex(p => p.chips > 0);
  if (currentTurnIndex === -1) currentTurnIndex = 0;

  broadcastState();
}

// Start ny runde automatisk så lenge noen fortsatt har penger
function scheduleNextHand() {
  clearTimeout(nextHandTimer);
  nextHandTimer = setTimeout(() => {
    nextHandTimer = null;
    if (gameStatus === 'GAME_OVER' && players.some(p => p.chips > 0)) {
      startNewHand();
    }
  }, NEXT_HAND_DELAY_MS);
}

function nextTurn() {
  currentTurnIndex++;
  
  skipInactivePlayers();

  if (currentTurnIndex >= players.length) {
    finishDealerTurn();
  } else {
    broadcastState();
  }
}

function broadcastState() {
  const dealerScore = (gameStatus === 'GAME_OVER' || gameStatus === 'PLAYING')
    ? calculateHand(dealerHand) 
    : 0;

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
      isEliminated: p.chips === 0 && p.bet === 0,
      resultText: p.resultText || '',
      isCurrentTurn: gameStatus === 'PLAYING' && index === currentTurnIndex
    }))
  });

  players.forEach((p, index) => {
    io.to(p.id).emit('player_state', {
      gameStatus,
      hand: p.hand,
      score: p.score,
      bet: p.bet,
      chips: p.chips,
      hasBet: p.hasBet,
      isEliminated: p.chips === 0 && p.bet === 0,
      resultText: p.resultText || '',
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
        name: data.name || 'Spiller',
        hand: [],
        score: 0,
        bet: 0,
        chips: 500,
        hasBet: false,
        resultText: ''
      };
      players.push(player);
    }

    // Første spiller ved bordet starter innsatsrunden automatisk
    if (gameStatus === 'WAITING') {
      startNewHand();
      return;
    }
    broadcastState();
  });

  socket.on('start_new_hand', startNewHand);

  socket.on('reset_game', () => {
    clearTimeout(nextHandTimer);
    nextHandTimer = null;
    players = [];
    dealerHand = [];
    gameStatus = 'WAITING';
    broadcastState();
  });

  socket.on('place_bet', (data) => {
    const player = players.find(p => p.id === socket.id);
    if (gameStatus !== 'BETTING' || !player || player.hasBet || player.chips === 0) return;

    let betAmount = parseInt(data.amount, 10);
    if (!(betAmount > 0)) betAmount = 50;
    if (betAmount > player.chips) betAmount = player.chips;

    player.bet = betAmount;
    player.chips -= betAmount;
    player.hasBet = true;

    // Del ut kort når alle aktive spillere har bydd
    if (allActiveHaveBet()) {
      dealCards();
      return;
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
        nextTurn();
      } else {
        broadcastState();
      }
    }
  });

  socket.on('player_stand', () => {
    if (gameStatus !== 'PLAYING') return;
    const currentPlayer = players[currentTurnIndex];
    if (currentPlayer && currentPlayer.id === socket.id) {
      nextTurn();
    }
  });

  socket.on('disconnect', () => {
    const index = players.findIndex(p => p.id === socket.id);
    if (index === -1) return;
    players.splice(index, 1);

    // Tomt bord – gå tilbake til venting
    if (players.length === 0) {
      clearTimeout(nextHandTimer);
      nextHandTimer = null;
      dealerHand = [];
      gameStatus = 'WAITING';
      broadcastState();
      return;
    }

    if (gameStatus === 'PLAYING') {
      // Hold turen på riktig spiller når listen forskyves
      if (index < currentTurnIndex) {
        currentTurnIndex--;
      } else if (index === currentTurnIndex) {
        // Spilleren som hadde tur forsvant – gi turen videre
        skipInactivePlayers();
        if (currentTurnIndex >= players.length) {
          finishDealerTurn();
          return;
        }
      }
    } else if (gameStatus === 'BETTING' && allActiveHaveBet()) {
      // Den siste som manglet innsats forsvant
      dealCards();
      return;
    }

    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));