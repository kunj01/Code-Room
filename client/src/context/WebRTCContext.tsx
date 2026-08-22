import React, { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react'
import { toast } from 'react-hot-toast'
import { CallState, CallStatus, MediaState, WebRTCConfig } from '@/types/webrtc'
import { SocketEvent } from '@/types/socket'
import { RemoteUser } from '@/types/user'
import { useSocket } from './SocketContext'
import { useAppContext } from './AppContext'

interface WebRTCContextType {
    callState: CallState
    callStatus: CallStatus
    localMediaState: MediaState
    remoteMediaState: MediaState
    initiateCall: (targetUser: RemoteUser) => void // audio-only removed
    acceptCall: () => void
    rejectCall: () => void
    endCall: () => void
    toggleVideo: () => void
    toggleAudio: () => void
    isVideoEnabled: boolean
    isAudioEnabled: boolean
}

const WebRTCContext = createContext<WebRTCContextType | null>(null)

export const useWebRTC = (): WebRTCContextType => {
    const context = useContext(WebRTCContext)
    if (!context) {
        throw new Error('useWebRTC must be used within a WebRTCProvider')
    }
    return context
}

// WebRTC Configuration with STUN servers
const webRTCConfig: WebRTCConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
}

const WebRTCProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const { socket } = useSocket()
    const { currentUser } = useAppContext()
    
    const [callState, setCallState] = useState<CallState>({
        isInCall: false,
        isIncomingCall: false,
        isOutgoingCall: false,
        callType: 'video',
    })
    
    const [callStatus, setCallStatus] = useState<CallStatus>(CallStatus.IDLE)
    const [localMediaState, setLocalMediaState] = useState<MediaState>({ video: true, audio: true })
    const [remoteMediaState, setRemoteMediaState] = useState<MediaState>({ video: true, audio: true })
    
    // Keep latest callState in a ref to avoid stale closures inside peer connection callbacks
    const callStateRef = useRef<CallState>(callState)
    React.useEffect(() => { callStateRef.current = callState }, [callState])
    
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
    const localStreamRef = useRef<MediaStream | null>(null)
    const remoteStreamRef = useRef<MediaStream | null>(null)
    
    const isVideoEnabled = localMediaState.video
    const isAudioEnabled = localMediaState.audio

    // Clean up WebRTC connections
    const cleanupWebRTC = useCallback(() => {
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => track.stop())
            localStreamRef.current = null
        }
        
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close()
            peerConnectionRef.current = null
        }
        
        remoteStreamRef.current = null
        
        setCallState({
            isInCall: false,
            isIncomingCall: false,
            isOutgoingCall: false,
            callType: 'video',
        })
        setCallStatus(CallStatus.IDLE)
    }, [])

    // Initialize peer connection
    const createPeerConnection = useCallback(() => {
        const pc = new RTCPeerConnection(webRTCConfig)
        
        pc.onicecandidate = (event) => {
            if (!event.candidate) return
            const currentCall = callStateRef.current
            const targetSocketId = currentCall.isOutgoingCall 
                ? currentCall.callee?.socketId 
                : currentCall.caller?.socketId
            if (targetSocketId) {
                socket.emit(SocketEvent.ICE_CANDIDATE, {
                    targetUserId: targetSocketId,
                    candidate: event.candidate,
                })
            }
        }
        
        pc.ontrack = (event) => {
            remoteStreamRef.current = event.streams[0]
            setCallState(prev => ({ ...prev, remoteStream: event.streams[0] }))
        }
        
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                setCallStatus(CallStatus.CONNECTED)
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                setCallStatus(CallStatus.FAILED)
                toast.error('Call connection failed')
                cleanupWebRTC()
            }
        }
        
        return pc
    }, [socket, cleanupWebRTC])

    // Get user media (always video now)
    const getUserMedia = useCallback(async () => {
        try {
            const constraints = {
                video: true,
                audio: true,
            }
            
            const stream = await navigator.mediaDevices.getUserMedia(constraints)
            localStreamRef.current = stream
            setCallState(prev => ({ ...prev, localStream: stream }))
            return stream
        } catch (error) {
            console.error('Error accessing media devices:', error)
            toast.error('Failed to access camera/microphone')
            throw error
        }
    }, [])

    // Initiate call (video only)
    const initiateCall = useCallback(async (targetUser: RemoteUser) => {
        if (!currentUser) return
        
        try {
            setCallStatus(CallStatus.INITIATING)
            setCallState({
                isInCall: false,
                isIncomingCall: false,
                isOutgoingCall: true,
                callType: 'video',
                caller: {
                    username: currentUser.username,
                    socketId: socket.id || '',
                },
                callee: targetUser,
            })
            
            const stream = await getUserMedia()
            const pc = createPeerConnection()
            peerConnectionRef.current = pc
            
            stream.getTracks().forEach(track => {
                pc.addTrack(track, stream)
            })
            
            socket.emit(SocketEvent.CALL_INITIATE, {
                targetUserId: targetUser.socketId,
                callType: 'video',
            })
            
            setCallStatus(CallStatus.RINGING)
            toast.success(`Calling ${targetUser.username}...`)
            
        } catch (error) {
            console.error('Failed to initiate call:', error)
            cleanupWebRTC()
        }
    }, [currentUser, socket, getUserMedia, createPeerConnection, cleanupWebRTC])

    // Accept incoming call
    const acceptCall = useCallback(async () => {
        if (!callState.isIncomingCall || !callState.caller) return
        
        try {
            setCallStatus(CallStatus.CONNECTING)
            
            const stream = await getUserMedia()
            const pc = createPeerConnection()
            peerConnectionRef.current = pc
            
            stream.getTracks().forEach(track => {
                pc.addTrack(track, stream)
            })
            
            setCallState(prev => ({
                ...prev,
                isInCall: true,
                isIncomingCall: false,
            }))
            
            socket.emit(SocketEvent.CALL_ACCEPTED, {
                targetUserId: callState.caller.socketId,
            })
            
            toast.success('Call accepted')
            
        } catch (error) {
            console.error('Failed to accept call:', error)
            rejectCall()
        }
    }, [callState, socket, getUserMedia, createPeerConnection])

    // Reject call
    const rejectCall = useCallback(() => {
        if (callState.caller) {
            socket.emit(SocketEvent.CALL_REJECT, {
                targetUserId: callState.caller.socketId,
            })
        }
        setCallStatus(CallStatus.REJECTED)
        toast.error('Call rejected')
        cleanupWebRTC()
    }, [callState.caller, socket, cleanupWebRTC])

    // End call
    const endCall = useCallback(() => {
        const targetSocketId = callState.isOutgoingCall 
            ? callState.callee?.socketId 
            : callState.caller?.socketId
            
        if (targetSocketId) {
            socket.emit(SocketEvent.CALL_END, {
                targetUserId: targetSocketId,
            })
        }
        
        setCallStatus(CallStatus.ENDED)
        toast.success('Call ended')
        cleanupWebRTC()
    }, [callState, socket, cleanupWebRTC])

    // Toggle video
    const toggleVideo = useCallback(() => {
        if (localStreamRef.current) {
            const videoTrack = localStreamRef.current.getVideoTracks()[0]
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled
                setLocalMediaState(prev => {
                    const newVideoState = !prev.video
                    const updated: MediaState = { ...prev, video: newVideoState }
                    const currentCall = callStateRef.current
                    const targetSocketId = currentCall.isOutgoingCall 
                        ? currentCall.callee?.socketId 
                        : currentCall.caller?.socketId
                    if (targetSocketId) {
                        socket.emit(SocketEvent.USER_MEDIA_STATE, {
                            targetUserId: targetSocketId,
                            mediaState: updated,
                        })
                    }
                    return updated
                })
            }
        }
    }, [socket])

    // Toggle audio
    const toggleAudio = useCallback(() => {
        if (localStreamRef.current) {
            const audioTrack = localStreamRef.current.getAudioTracks()[0]
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled
                setLocalMediaState(prev => {
                    const newAudioState = !prev.audio
                    const updated: MediaState = { ...prev, audio: newAudioState }
                    const currentCall = callStateRef.current
                    const targetSocketId = currentCall.isOutgoingCall 
                        ? currentCall.callee?.socketId 
                        : currentCall.caller?.socketId
                    if (targetSocketId) {
                        socket.emit(SocketEvent.USER_MEDIA_STATE, {
                            targetUserId: targetSocketId,
                            mediaState: updated,
                        })
                    }
                    return updated
                })
            }
        }
    }, [socket])

    // Socket event listeners
    React.useEffect(() => {
        // Handle incoming call (always video now)
        socket.on(SocketEvent.CALL_INITIATE, ({ from /* callType */ }) => {
            if (callStatus === CallStatus.IDLE) {
                setCallState({
                    isInCall: false,
                    isIncomingCall: true,
                    isOutgoingCall: false,
                    callType: 'video',
                    caller: from,
                })
                setCallStatus(CallStatus.RINGING)
                toast.success(`Incoming video call from ${from.username}`)
            }
        })

        socket.on(SocketEvent.CALL_OFFER, async ({ from, offer }) => {
            if (peerConnectionRef.current) {
                await peerConnectionRef.current.setRemoteDescription(offer)
                const answer = await peerConnectionRef.current.createAnswer()
                await peerConnectionRef.current.setLocalDescription(answer)
                
                socket.emit(SocketEvent.CALL_ANSWER, {
                    targetUserId: from.socketId,
                    answer,
                })
            }
        })

        socket.on(SocketEvent.CALL_ANSWER, async ({ answer }) => {
            if (peerConnectionRef.current) {
                await peerConnectionRef.current.setRemoteDescription(answer)
            }
        })

        socket.on(SocketEvent.ICE_CANDIDATE, async ({ candidate }) => {
            if (peerConnectionRef.current) {
                await peerConnectionRef.current.addIceCandidate(candidate)
            }
        })

        socket.on(SocketEvent.CALL_ACCEPTED, async ({ from }) => {
            if (peerConnectionRef.current && callState.isOutgoingCall) {
                const offer = await peerConnectionRef.current.createOffer()
                await peerConnectionRef.current.setLocalDescription(offer)
                
                socket.emit(SocketEvent.CALL_OFFER, {
                    targetUserId: from.socketId,
                    offer,
                    callType: 'video',
                })
                
                setCallState(prev => ({
                    ...prev,
                    isInCall: true,
                    isOutgoingCall: false,
                }))
                setCallStatus(CallStatus.CONNECTING)
            }
        })

        socket.on(SocketEvent.CALL_REJECT, ({ from }) => {
            setCallStatus(CallStatus.REJECTED)
            toast.error(`${from.username} rejected the call`)
            cleanupWebRTC()
        })

        socket.on(SocketEvent.CALL_END, ({ from }) => {
            setCallStatus(CallStatus.ENDED)
            toast.success(`Call ended by ${from.username}`)
            cleanupWebRTC()
        })

        socket.on(SocketEvent.USER_MEDIA_STATE, ({ mediaState }) => {
            setRemoteMediaState(mediaState)
        })

        return () => {
            socket.off(SocketEvent.CALL_INITIATE)
            socket.off(SocketEvent.CALL_OFFER)
            socket.off(SocketEvent.CALL_ANSWER)
            socket.off(SocketEvent.ICE_CANDIDATE)
            socket.off(SocketEvent.CALL_ACCEPTED)
            socket.off(SocketEvent.CALL_REJECT)
            socket.off(SocketEvent.CALL_END)
            socket.off(SocketEvent.USER_MEDIA_STATE)
        }
    }, [socket, callState, callStatus, cleanupWebRTC])

    React.useEffect(() => {
        return () => {
            cleanupWebRTC()
        }
    }, [cleanupWebRTC])

    const value: WebRTCContextType = {
        callState,
        callStatus,
        localMediaState,
        remoteMediaState,
        initiateCall,
        acceptCall,
        rejectCall,
        endCall,
        toggleVideo,
        toggleAudio,
        isVideoEnabled,
        isAudioEnabled,
    }

    return (
        <WebRTCContext.Provider value={value}>
            {children}
        </WebRTCContext.Provider>
    )
}

export default WebRTCProvider
