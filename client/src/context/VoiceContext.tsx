import React, { createContext, useContext, useState, useCallback, useRef, ReactNode, useEffect } from 'react'
import { toast } from 'react-hot-toast'
import { useSocket } from './SocketContext'
import { useAppContext } from './AppContext'

// Voice Chat specific types
export interface VoiceState {
    isConnected: boolean
    isMuted: boolean
    isDeafened: boolean
    localStream?: MediaStream
    remoteStreams: Map<string, MediaStream>
    participants: Map<string, VoiceParticipant>
}

export interface VoiceParticipant {
    socketId: string
    username: string
    isMuted: boolean
    isConnected: boolean
    audioLevel: number
}

interface VoiceContextType {
    voiceState: VoiceState
    joinVoiceChannel: () => Promise<void>
    leaveVoiceChannel: () => void
    toggleMute: () => void
    toggleDeafen: () => void
    getParticipantAudioLevel: (socketId: string) => number
}

const VoiceContext = createContext<VoiceContextType | null>(null)

export const useVoice = (): VoiceContextType => {
    const context = useContext(VoiceContext)
    if (!context) {
        throw new Error('useVoice must be used within a VoiceProvider')
    }
    return context
}

// WebRTC Configuration for voice
const voiceRTCConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
}

const VoiceProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const { socket } = useSocket()
    const { currentUser, users } = useAppContext()
    
    const [voiceState, setVoiceState] = useState<VoiceState>({
        isConnected: false,
        isMuted: false,
        isDeafened: false,
        remoteStreams: new Map(),
        participants: new Map(),
    })

    const localStreamRef = useRef<MediaStream | null>(null)
    const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
    const audioContextRef = useRef<AudioContext | null>(null)
    const audioLevelsRef = useRef<Map<string, number>>(new Map())

    // Clean up all voice connections
    const cleanupVoiceConnections = useCallback(() => {
        // Stop local stream
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => track.stop())
            localStreamRef.current = null
        }

        // Close all peer connections
        peerConnectionsRef.current.forEach(pc => pc.close())
        peerConnectionsRef.current.clear()

        // Close audio context
        if (audioContextRef.current) {
            audioContextRef.current.close()
            audioContextRef.current = null
        }

        setVoiceState(prev => ({
            ...prev,
            isConnected: false,
            localStream: undefined,
            remoteStreams: new Map(),
            participants: new Map(),
        }))
    }, [])

    // Create peer connection for a user
    const createPeerConnection = useCallback((socketId: string, isInitiator: boolean = false) => {
        const pc = new RTCPeerConnection(voiceRTCConfig)

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('voice-ice-candidate', {
                    targetSocketId: socketId,
                    candidate: event.candidate,
                })
            }
        }

        pc.ontrack = (event) => {
            const remoteStream = event.streams[0]
            setVoiceState(prev => {
                const newRemoteStreams = new Map(prev.remoteStreams)
                newRemoteStreams.set(socketId, remoteStream)
                return {
                    ...prev,
                    remoteStreams: newRemoteStreams,
                }
            })

            // Create audio element to play the stream
            const audio = document.createElement('audio')
            audio.srcObject = remoteStream
            audio.autoplay = true
            // Set additional properties for mobile compatibility
            audio.setAttribute('playsinline', 'true')
            document.body.appendChild(audio)

            // Remove audio element when stream ends
            remoteStream.onremovetrack = () => {
                document.body.removeChild(audio)
            }
        }

        pc.onconnectionstatechange = () => {
            console.log(`Voice connection state with ${socketId}:`, pc.connectionState)
            if (pc.connectionState === 'connected') {
                setVoiceState(prev => {
                    const newParticipants = new Map(prev.participants)
                    const participant = newParticipants.get(socketId)
                    if (participant) {
                        newParticipants.set(socketId, {
                            ...participant,
                            isConnected: true,
                        })
                    }
                    return { ...prev, participants: newParticipants }
                })
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                setVoiceState(prev => {
                    const newParticipants = new Map(prev.participants)
                    const newRemoteStreams = new Map(prev.remoteStreams)
                    newParticipants.delete(socketId)
                    newRemoteStreams.delete(socketId)
                    return {
                        ...prev,
                        participants: newParticipants,
                        remoteStreams: newRemoteStreams,
                    }
                })
                peerConnectionsRef.current.delete(socketId)
            }
        }

        // Add local stream to peer connection
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => {
                pc.addTrack(track, localStreamRef.current!)
            })
        }

        peerConnectionsRef.current.set(socketId, pc)

        // If we're the initiator, create and send offer
        if (isInitiator) {
            pc.createOffer().then(offer => {
                pc.setLocalDescription(offer)
                socket.emit('voice-offer', {
                    targetSocketId: socketId,
                    offer,
                })
            })
        }

        return pc
    }, [socket])

    // Join voice channel
    const joinVoiceChannel = useCallback(async () => {
        try {
            // Get audio stream
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
                video: false,
            })

            localStreamRef.current = stream
            setVoiceState(prev => ({
                ...prev,
                isConnected: true,
                localStream: stream,
            }))

            // Create audio context for level detection
            audioContextRef.current = new AudioContext()

            // Notify other users that we joined voice
            socket.emit('voice-join', {
                username: currentUser?.username,
            })

            // Create connections to existing voice participants
            users.forEach(user => {
                if (user.socketId !== socket.id) {
                    setVoiceState(prev => {
                        const newParticipants = new Map(prev.participants)
                        newParticipants.set(user.socketId, {
                            socketId: user.socketId,
                            username: user.username,
                            isMuted: false,
                            isConnected: false,
                            audioLevel: 0,
                        })
                        return { ...prev, participants: newParticipants }
                    })
                }
            })

            toast.success('Joined voice channel')
        } catch (error) {
            console.error('Failed to join voice channel:', error)
            toast.error('Failed to access microphone')
        }
    }, [socket, currentUser, users])

    // Leave voice channel
    const leaveVoiceChannel = useCallback(() => {
        socket.emit('voice-leave')
        cleanupVoiceConnections()
        toast.success('Left voice channel')
    }, [socket, cleanupVoiceConnections])

    // Toggle mute
    const toggleMute = useCallback(() => {
        if (localStreamRef.current) {
            const audioTrack = localStreamRef.current.getAudioTracks()[0]
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled
                const newMutedState = !audioTrack.enabled

                setVoiceState(prev => ({
                    ...prev,
                    isMuted: newMutedState,
                }))

                socket.emit('voice-mute-state', {
                    isMuted: newMutedState,
                })

                toast.success(newMutedState ? 'Microphone muted' : 'Microphone unmuted')
            }
        }
    }, [socket])

    // Toggle deafen (mute all incoming audio)
    const toggleDeafen = useCallback(() => {
        const newDeafenState = !voiceState.isDeafened
        
        // Mute/unmute all audio elements
        const audioElements = document.querySelectorAll('audio')
        audioElements.forEach(audio => {
            audio.muted = newDeafenState
        })

        setVoiceState(prev => ({
            ...prev,
            isDeafened: newDeafenState,
        }))

        toast.success(newDeafenState ? 'Deafened' : 'Undeafened')
    }, [voiceState.isDeafened])

    // Get participant audio level
    const getParticipantAudioLevel = useCallback((socketId: string) => {
        return audioLevelsRef.current.get(socketId) || 0
    }, [])

    // Socket event handlers
    useEffect(() => {
        // Handle new user joining voice
        socket.on('voice-user-joined', ({ user }) => {
            if (voiceState.isConnected) {
                setVoiceState(prev => {
                    const newParticipants = new Map(prev.participants)
                    newParticipants.set(user.socketId, {
                        socketId: user.socketId,
                        username: user.username,
                        isMuted: false,
                        isConnected: false,
                        audioLevel: 0,
                    })
                    return { ...prev, participants: newParticipants }
                })

                // Create peer connection as initiator
                createPeerConnection(user.socketId, true)
            }
        })

        // Handle user leaving voice
        socket.on('voice-user-left', ({ socketId }) => {
            const pc = peerConnectionsRef.current.get(socketId)
            if (pc) {
                pc.close()
                peerConnectionsRef.current.delete(socketId)
            }

            setVoiceState(prev => {
                const newParticipants = new Map(prev.participants)
                const newRemoteStreams = new Map(prev.remoteStreams)
                newParticipants.delete(socketId)
                newRemoteStreams.delete(socketId)
                return {
                    ...prev,
                    participants: newParticipants,
                    remoteStreams: newRemoteStreams,
                }
            })
        })

        // Handle voice offer
        socket.on('voice-offer', async ({ fromSocketId, offer }) => {
            const pc = createPeerConnection(fromSocketId, false)
            await pc.setRemoteDescription(offer)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            
            socket.emit('voice-answer', {
                targetSocketId: fromSocketId,
                answer,
            })
        })

        // Handle voice answer
        socket.on('voice-answer', async ({ fromSocketId, answer }) => {
            const pc = peerConnectionsRef.current.get(fromSocketId)
            if (pc) {
                await pc.setRemoteDescription(answer)
            }
        })

        // Handle ICE candidates
        socket.on('voice-ice-candidate', async ({ fromSocketId, candidate }) => {
            const pc = peerConnectionsRef.current.get(fromSocketId)
            if (pc) {
                await pc.addIceCandidate(candidate)
            }
        })

        // Handle mute state changes
        socket.on('voice-mute-state', ({ fromSocketId, isMuted }) => {
            setVoiceState(prev => {
                const newParticipants = new Map(prev.participants)
                const participant = newParticipants.get(fromSocketId)
                if (participant) {
                    newParticipants.set(fromSocketId, {
                        ...participant,
                        isMuted,
                    })
                }
                return { ...prev, participants: newParticipants }
            })
        })

        return () => {
            socket.off('voice-user-joined')
            socket.off('voice-user-left')
            socket.off('voice-offer')
            socket.off('voice-answer')
            socket.off('voice-ice-candidate')
            socket.off('voice-mute-state')
        }
    }, [socket, voiceState.isConnected, createPeerConnection])

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            cleanupVoiceConnections()
        }
    }, [cleanupVoiceConnections])

    const value: VoiceContextType = {
        voiceState,
        joinVoiceChannel,
        leaveVoiceChannel,
        toggleMute,
        toggleDeafen,
        getParticipantAudioLevel,
    }

    return (
        <VoiceContext.Provider value={value}>
            {children}
        </VoiceContext.Provider>
    )
}

export default VoiceProvider
