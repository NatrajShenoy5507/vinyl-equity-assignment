import { GoogleGenAI } from "@google/genai";
export class GeminiAgent {
    apiKey;
    model;
    client;
    constructor(apiKey, model) {
        this.apiKey = apiKey;
        this.model = model;
        if (!apiKey)
            throw new Error("GEMINI_API_KEY is not configured. Copy .env.example to .env and add a Gemini Developer API key.");
        this.client = new GoogleGenAI({ apiKey });
    }
    async generateJson(prompt, schema, timeoutMs = 30_000) {
        const response = await this.client.models.generateContent({
            model: this.model,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseJsonSchema: schema,
                temperature: 0.1,
                httpOptions: { timeout: timeoutMs },
            },
        });
        if (!response.text)
            throw new Error("Gemini returned an empty response; verify model access and API quota.");
        try {
            return JSON.parse(response.text);
        }
        catch (error) {
            throw new Error(`Gemini returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
