import express, { Response, Request } from "express"
import dotenv from "dotenv"
import http from "http"
import cors from "cors"
import { SocketEvent, SocketId } from "./types/socket"
import { USER_CONNECTION_STATUS, User } from "./types/user"
import { Server } from "socket.io"
import path from "path"

dotenv.config()

const app = express()

app.use(express.json())

app.use(cors())

app.use(express.static(path.join(__dirname, "public"))) // Serve static files

const server = http.createServer(app)
const io = new Server(server, {
	cors: {
		origin: "*",
	},
	maxHttpBufferSize: 1e8,
	pingTimeout: 60000,
})

let userSocketMap: User[] = []

// Function to get all users in a room
function getUsersInRoom(roomId: string): User[] {
	return userSocketMap.filter((user) => user.roomId == roomId)
}

// Function to get room id by socket id
function getRoomId(socketId: SocketId): string | null {
	const roomId = userSocketMap.find(
		(user) => user.socketId === socketId
	)?.roomId

	if (!roomId) {
		console.error("Room ID is undefined for socket ID:", socketId)
		return null
	}
	return roomId
}

function getUserBySocketId(socketId: SocketId): User | null {
	const user = userSocketMap.find((user) => user.socketId === socketId)
	if (!user) {
		console.error("User not found for socket ID:", socketId)
		return null
	}
	return user
}
io.on("connection", (socket) => {
	// Handle user actions
	socket.on(SocketEvent.JOIN_REQUEST, ({ roomId, username }) => {
		// Check is username exist in the room
		const isUsernameExist = getUsersInRoom(roomId).filter(
			(u) => u.username === username
		)
		if (isUsernameExist.length > 0) {
			io.to(socket.id).emit(SocketEvent.USERNAME_EXISTS)
			return
		}

		const user = {
			username,
			roomId,
			status: USER_CONNECTION_STATUS.ONLINE,
			cursorPosition: 0,
			typing: false,
			socketId: socket.id,
			currentFile: null,
		}
		userSocketMap.push(user)
		socket.join(roomId)
		socket.broadcast.to(roomId).emit(SocketEvent.USER_JOINED, { user })
		const users = getUsersInRoom(roomId)
		io.to(socket.id).emit(SocketEvent.JOIN_ACCEPTED, { user, users })
	})

	socket.on("disconnecting", () => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.USER_DISCONNECTED, { user })
		userSocketMap = userSocketMap.filter((u) => u.socketId !== socket.id)
		socket.leave(roomId)
	})

	// Handle file actions
	socket.on(
		SocketEvent.SYNC_FILE_STRUCTURE,
		({ fileStructure, openFiles, activeFile, socketId }) => {
			io.to(socketId).emit(SocketEvent.SYNC_FILE_STRUCTURE, {
				fileStructure,
				openFiles,
				activeFile,
			})
		}
	)
	socket.on(
		SocketEvent.DIRECTORY_CREATED,
		({ parentDirId, newDirectory }) => {
			const roomId = getRoomId(socket.id)
			if (!roomId) return
			socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_CREATED, {
				parentDirId,
				newDirectory,
			})
		}
	)

	socket.on(SocketEvent.DIRECTORY_UPDATED, ({ dirId, children }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_UPDATED, {
			dirId,
			children,
		})
	})

	socket.on(SocketEvent.DIRECTORY_RENAMED, ({ dirId, newName }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_RENAMED, {
			dirId,
			newName,
		})
	})

	socket.on(SocketEvent.DIRECTORY_DELETED, ({ dirId }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.DIRECTORY_DELETED, { dirId })
	})

	socket.on(SocketEvent.FILE_CREATED, ({ parentDirId, newFile }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.FILE_CREATED, { parentDirId, newFile })
	})

	socket.on(SocketEvent.FILE_UPDATED, ({ fileId, newContent }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_UPDATED, {
			fileId,
			newContent,
		})
	})

	socket.on(SocketEvent.FILE_RENAMED, ({ fileId, newName }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_RENAMED, {
			fileId,
			newName,
		})
	})

	socket.on(SocketEvent.FILE_DELETED, ({ fileId }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_DELETED, { fileId })
	})

	// Handle user status
	socket.on(SocketEvent.USER_OFFLINE, ({ socketId }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socketId) {
				return { ...user, status: USER_CONNECTION_STATUS.OFFLINE }
			}
			return user
		})
		const roomId = getRoomId(socketId)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.USER_OFFLINE, { socketId })
	})

	socket.on(SocketEvent.USER_ONLINE, ({ socketId }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socketId) {
				return { ...user, status: USER_CONNECTION_STATUS.ONLINE }
			}
			return user
		})
		const roomId = getRoomId(socketId)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.USER_ONLINE, { socketId })
	})

	// Handle chat actions
	socket.on(SocketEvent.SEND_MESSAGE, ({ message }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.RECEIVE_MESSAGE, { message })
	})

	// Handle cursor position
	socket.on(SocketEvent.TYPING_START, ({ cursorPosition }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socket.id) {
				return { ...user, typing: true, cursorPosition }
			}
			return user
		})
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast.to(roomId).emit(SocketEvent.TYPING_START, { user })
	})

	socket.on(SocketEvent.TYPING_PAUSE, () => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socket.id) {
				return { ...user, typing: false }
			}
			return user
		})
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast.to(roomId).emit(SocketEvent.TYPING_PAUSE, { user })
	})

	socket.on(SocketEvent.REQUEST_DRAWING, () => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.REQUEST_DRAWING, { socketId: socket.id })
	})

	socket.on(SocketEvent.SYNC_DRAWING, ({ drawingData, socketId }) => {
		socket.broadcast
			.to(socketId)
			.emit(SocketEvent.SYNC_DRAWING, { drawingData })
	})

	socket.on(SocketEvent.DRAWING_UPDATE, ({ snapshot }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.DRAWING_UPDATE, {
			snapshot,
		})
	})

	// Handle WebRTC video call signaling (audio-only removed)
	socket.on(SocketEvent.CALL_INITIATE, ({ targetUserId, callType }) => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		
		io.to(targetUserId).emit(SocketEvent.CALL_INITIATE, {
			from: user,
			callType,
		})
	})

	socket.on(SocketEvent.CALL_OFFER, ({ targetUserId, offer, callType }) => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		
		io.to(targetUserId).emit(SocketEvent.CALL_OFFER, {
			from: user,
			offer,
			callType,
		})
	})

	socket.on(SocketEvent.CALL_ANSWER, ({ targetUserId, answer }) => {
		io.to(targetUserId).emit(SocketEvent.CALL_ANSWER, {
			answer,
			from: socket.id,
		})
	})

	socket.on(SocketEvent.ICE_CANDIDATE, ({ targetUserId, candidate }) => {
		io.to(targetUserId).emit(SocketEvent.ICE_CANDIDATE, {
			candidate,
			from: socket.id,
		})
	})

	socket.on(SocketEvent.CALL_REJECT, ({ targetUserId }) => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		
		io.to(targetUserId).emit(SocketEvent.CALL_REJECT, {
			from: user,
		})
	})

	socket.on(SocketEvent.CALL_END, ({ targetUserId }) => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		
		io.to(targetUserId).emit(SocketEvent.CALL_END, {
			from: user,
		})
	})

	socket.on(SocketEvent.CALL_ACCEPTED, ({ targetUserId }) => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		
		io.to(targetUserId).emit(SocketEvent.CALL_ACCEPTED, {
			from: user,
		})
	})

	socket.on(SocketEvent.USER_MEDIA_STATE, ({ targetUserId, mediaState }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		
		if (targetUserId) {
			io.to(targetUserId).emit(SocketEvent.USER_MEDIA_STATE, {
				from: socket.id,
				mediaState,
			})
		} else {
			socket.broadcast.to(roomId).emit(SocketEvent.USER_MEDIA_STATE, {
				from: socket.id,
				mediaState,
			})
		}
	})

	// Handle Voice Chat (Persistent Audio)
	socket.on('voice-join', ({ username }) => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		
		socket.broadcast.to(roomId).emit('voice-user-joined', {
			user: {
				socketId: socket.id,
				username: username || user.username,
			},
		})
	})

	socket.on('voice-leave', () => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		
		socket.broadcast.to(roomId).emit('voice-user-left', {
			socketId: socket.id,
		})
	})

	socket.on('voice-offer', ({ targetSocketId, offer }) => {
		io.to(targetSocketId).emit('voice-offer', {
			fromSocketId: socket.id,
			offer,
		})
	})

	socket.on('voice-answer', ({ targetSocketId, answer }) => {
		io.to(targetSocketId).emit('voice-answer', {
			fromSocketId: socket.id,
			answer,
		})
	})

	socket.on('voice-ice-candidate', ({ targetSocketId, candidate }) => {
		io.to(targetSocketId).emit('voice-ice-candidate', {
			fromSocketId: socket.id,
			candidate,
		})
	})

	socket.on('voice-mute-state', ({ isMuted }) => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		
		socket.broadcast.to(roomId).emit('voice-mute-state', {
			fromSocketId: socket.id,
			isMuted,
		})
	})
})

const PORT = process.env.PORT || 3000

app.get("/", (req: Request, res: Response) => {
	// Send the index.html file
	res.sendFile(path.join(__dirname, "..", "public", "index.html"))
})

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
	res.status(200).json({
		status: "OK",
		timestamp: new Date().toISOString(),
		uptime: process.uptime(),
		message: "Server is healthy and running"
	})
})

server.listen(PORT, () => {
	console.log(`Listening on port ${PORT}`)
	
	// Keep-alive mechanism for Render free tier
	const RENDER_URL = process.env.RENDER_URL || `http://localhost:${PORT}`
	
	// Self-ping every 2 minutes (120000ms) to prevent sleep
	setInterval(async () => {
		try {
			const response = await fetch(`${RENDER_URL}/health`)
			if (response.ok) {
				console.log(`✓ Keep-alive ping successful at ${new Date().toISOString()}`)
			} else {
				console.log(`⚠ Keep-alive ping failed with status: ${response.status}`)
			}
		} catch (error) {
			console.log(`✗ Keep-alive ping error: ${error}`)
		}
	}, 120000) // 2 minutes
})
