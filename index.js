import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import bcryptjs from 'bcryptjs';
import { getRandomTruth, getRandomDare } from './questions.js';

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Хранилище
const rooms = {};
const HOST_LOGIN = 'x-ray';
const HOST_PASSWORD_HASH = bcryptjs.hashSync('Sv745619932013', 10);

// Аутентификация ведущего
app.post('/api/host-login', (req, res) => {
  const { login, password } = req.body;
  if (login === HOST_LOGIN && bcryptjs.compareSync(password, HOST_PASSWORD_HASH)) {
    res.json({ success: true, token: 'host-token-' + Date.now() });
  } else {
    res.json({ success: false, message: 'Неверный логин или пароль' });
  }
});

io.on('connection', (socket) => {
  console.log('Подключился:', socket.id);

  // Регистрация игрока
  socket.on('register', ({ roomId, name, avatar, avatarType, gender, isHost }) => {
    console.log(`Регистрация: ${name}, isHost: ${isHost}`);
    socket.join(roomId);
    
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        host: null,
        gameState: {
          started: false,
          currentPlayer: null,
          spinning: false,
          currentTask: null,
          taskType: null, // 'truth' или 'dare'
          truthCount: {} // Счетчик правды для каждого игрока
        },
        messages: [],
        history: []
      };
    }

    const player = {
      id: socket.id,
      name,
      avatar,
      avatarType: avatarType || 'emoji', // 'emoji' или 'image'
      gender,
      score: 0,
      isReady: false,
      truthStreak: 0 // Подряд выбрал правду
    };

    // Если это ведущий
    if (isHost) {
      rooms[roomId].host = socket.id;
      socket.emit('hostConnected', { roomId });
    } else {
      rooms[roomId].players.push(player);
    }

    // Отправляем всем обновление
    console.log(`Игроков в комнате ${roomId}: ${rooms[roomId].players.length}`);
    io.to(roomId).emit('roomUpdate', {
      players: rooms[roomId].players,
      gameState: rooms[roomId].gameState,
      hasHost: !!rooms[roomId].host
    });
  });

  // Готовность игрока
  socket.on('playerReady', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.isReady = true;
      io.to(roomId).emit('roomUpdate', {
        players: room.players,
        gameState: room.gameState,
        hasHost: !!room.host
      });
    }
  });

  // Старт игры (ведущий или авто)
  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.gameState.started = true;
    io.to(roomId).emit('gameStarted');
    io.to(roomId).emit('roomUpdate', {
      players: room.players,
      gameState: room.gameState,
      hasHost: !!room.host
    });
  });

  // Вращение бутылочки (любой игрок может крутить)
  socket.on('spinBottle', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.gameState.started) return;
    
    // Проверяем что не идет вращение
    if (room.gameState.spinning) return;

    room.gameState.spinning = true;
    
    // Генерируем случайный угол вращения
    const rotation = 360 * 5 + Math.floor(Math.random() * 360);
    
    io.to(roomId).emit('bottleSpinning', { rotation });

    // Через 2 секунды выбираем игрока
    setTimeout(() => {
      // Проверяем что есть игроки
      if (!room.players || room.players.length === 0) {
        room.gameState.spinning = false;
        return;
      }

      const randomPlayer = room.players[Math.floor(Math.random() * room.players.length)];
      if (!randomPlayer) return;

      room.gameState.spinning = false;
      room.gameState.currentPlayer = randomPlayer.id;

      io.to(roomId).emit('playerSelected', { 
        playerId: randomPlayer.id, 
        playerName: randomPlayer.name,
        truthStreak: randomPlayer.truthStreak || 0
      });
      io.to(roomId).emit('roomUpdate', {
        players: room.players,
        gameState: room.gameState,
        hasHost: !!room.host
      });
    }, 2000);
  });

  // Выбор правда/действие
  socket.on('chooseType', ({ roomId, type }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || room.gameState.currentPlayer !== socket.id) return;

    // Проверка правила "3 правды" - ПРАВДУ нельзя выбрать если счетчик >= 3
    if (type === 'truth') {
      if (player.truthStreak >= 3) {
        // Блокируем выбор правды
        io.to(socket.id).emit('mustChooseDare', { message: 'Ты уже выбрал "Правда" 3 раза подряд! Теперь только "Действие"!' });
        return;
      }
      // Увеличиваем счетчик
      player.truthStreak++;
    } else {
      // "Действие" всегда доступно и обнуляет счетчик
      player.truthStreak = 0;
    }

    room.gameState.taskType = type;

    // Генерируем задание
    let task;
    if (type === 'truth') {
      task = getRandomTruth(player.gender);
    } else {
      task = getRandomDare(player.gender);
    }

    room.gameState.currentTask = task;

    // Отправляем задание
    io.to(roomId).emit('taskAssigned', {
      playerId: socket.id,
      playerName: player.name,
      type,
      task
    });
  });

  // Ведущий отправляет свое задание
  socket.on('hostSendTask', ({ roomId, playerId, task, type }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.host) return;

    room.gameState.currentTask = task;
    room.gameState.taskType = type;
    room.gameState.currentPlayer = playerId;

    io.to(roomId).emit('taskAssigned', {
      playerId,
      playerName: room.players.find(p => p.id === playerId)?.name,
      type,
      task
    });
  });

  // Завершение задания
  socket.on('taskCompleted', ({ roomId, success }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    // Начисление баллов
    if (success) {
      player.score += room.gameState.taskType === 'dare' ? 10 : 5;
    }

    room.gameState.currentPlayer = null;
    room.gameState.currentTask = null;
    room.gameState.taskType = null;

    io.to(roomId).emit('taskFinished', {
      playerId: socket.id,
      playerName: player.name,
      success,
      newScore: player.score
    });

    io.to(roomId).emit('roomUpdate', {
      players: room.players,
      gameState: room.gameState,
      hasHost: !!room.host
    });
  });

  // Ведущий управляет баллами
  socket.on('hostUpdateScore', ({ roomId, playerId, delta }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.host) return;

    const player = room.players.find(p => p.id === playerId);
    if (player) {
      player.score = Math.max(0, player.score + delta);
      io.to(roomId).emit('roomUpdate', {
        players: room.players,
        gameState: room.gameState,
        hasHost: !!room.host
      });
    }
  });

  // Чат
  socket.on('sendMessage', ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    const playerName = player ? player.name : 'Ведущий';

    const msg = {
      id: Date.now(),
      playerId: socket.id,
      playerName: playerName,
      message: message,
      timestamp: new Date().toISOString()
    };

    room.messages.push(msg);
    io.to(roomId).emit('newMessage', msg);
  });

  // Ведущий управляет звуком игрока
  socket.on('hostMutePlayer', ({ roomId, playerId, muted }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.host) return;

    io.to(playerId).emit('hostMuted', { muted });
  });

  // Ведущий выбирает игрока вручную
  socket.on('hostSelectPlayer', ({ roomId, playerId }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.host) return;

    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    room.gameState.currentPlayer = playerId;
    io.to(roomId).emit('playerSelected', { playerId: player.id, playerName: player.name });
    io.to(roomId).emit('roomUpdate', {
      players: room.players,
      gameState: room.gameState,
      hasHost: !!room.host
    });
  });

  // Ведущий отправляет свое задание (переопределяет текущее)
  socket.on('hostCustomTask', ({ roomId, task }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.host) return;

    if (!room.gameState.currentPlayer) return;

    room.gameState.currentTask = task;
    room.gameState.taskType = 'custom';
    
    io.to(roomId).emit('taskAssigned', { task, type: 'custom' });
    io.to(roomId).emit('roomUpdate', {
      players: room.players,
      gameState: room.gameState,
      hasHost: !!room.host
    });
  });

  // WebRTC сигналинг
  socket.on('webrtc-offer', ({ to, offer }) => {
    io.to(to).emit('webrtc-offer', { from: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ to, answer }) => {
    io.to(to).emit('webrtc-answer', { from: socket.id, answer });
  });

  socket.on('webrtc-candidate', ({ to, candidate }) => {
    io.to(to).emit('webrtc-candidate', { from: socket.id, candidate });
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('Отключился:', socket.id);
    
    for (const roomId in rooms) {
      const room = rooms[roomId];
      
      // Если это ведущий
      if (room.host === socket.id) {
        room.host = null;
        io.to(roomId).emit('hostDisconnected');
      }
      
      // Удаляем игрока
      room.players = room.players.filter(p => p.id !== socket.id);
      
      if (room.players.length === 0 && !room.host) {
        delete rooms[roomId];
      } else {
        io.to(roomId).emit('roomUpdate', {
          players: room.players,
          gameState: room.gameState,
          hasHost: !!room.host
        });
      }
    }
  });
});

app.get('/', (req, res) => {
  res.send('Bottle Game Server v2 is running!');
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
