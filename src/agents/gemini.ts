import { GoogleGenAI } from "@google/genai";

export class GeminiAgent {
  private readonly client: GoogleGenAI;

  constructor(readonly apiKey: string | undefined, readonly model: string) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured. Copy .env.example to .env and add a Gemini Developer API key.");
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateJson(prompt: string, schema: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
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
    if (!response.text) throw new Error("Gemini returned an empty response; verify model access and API quota.");
    try {
      return JSON.parse(response.text) as unknown;
    } catch (error) {
      throw new Error(`Gemini returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
