import Groq from "groq-sdk";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

async function testStream() {
  console.log("🚀 Starting Groq streaming test...\n");
  
  const stream = await groq.chat.completions.create({
    messages: [
      {
        role: "system",
        content: "You are a helpful assistant.",
      },
      {
        role: "user",
        content: "Explain the importance of fast language models in 3 sentences",
      },
    ],
    model: "llama-3.1-8b-instant",
    temperature: 0.5,
    max_completion_tokens: 512,
    top_p: 1,
    stream: true,
  });

  process.stdout.write("Assistant: ");
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || "";
    process.stdout.write(content);
  }
  console.log("\n\n✅ Stream complete!");
}

testStream();
