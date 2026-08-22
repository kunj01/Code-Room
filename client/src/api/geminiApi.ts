import { GoogleGenerativeAI } from "@google/generative-ai"

// Get API key from environment variable or use a placeholder
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "AIzaSyCkLQG4ZGDt5UFicPmZoIfLQBPvMqJSExo"

if (!API_KEY) {
    console.warn(
        "Gemini API key not found. Please set VITE_GEMINI_API_KEY in your .env file",
    )
}

// Initialize the Gemini API
const genAI = new GoogleGenerativeAI(API_KEY)

// Get the generative model
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" })

export const generateWithGemini = async (
    systemPrompt: string,
    userPrompt: string,
): Promise<string> => {
    try {
        // Combine system and user prompts
        const fullPrompt = `${systemPrompt}\n\nUser: ${userPrompt}`

        // Generate content
        const result = await model.generateContent(fullPrompt)
        const response = result.response
        const text = response.text()

        return text
    } catch (error) {
        console.error("Error generating content with Gemini:", error)
        throw error
    }
}

export const generateWithGeminiStream = async (
    systemPrompt: string,
    userPrompt: string,
    onChunk: (text: string) => void,
): Promise<void> => {
    try {
        // Combine system and user prompts
        const fullPrompt = `${systemPrompt}\n\nUser: ${userPrompt}`

        // Generate content with streaming
        const result = await model.generateContentStream(fullPrompt)

        // Process the stream
        for await (const chunk of result.stream) {
            const chunkText = chunk.text()
            onChunk(chunkText)
        }
    } catch (error) {
        console.error("Error generating content with Gemini:", error)
        throw error
    }
}

export default { generateWithGemini, generateWithGeminiStream }
