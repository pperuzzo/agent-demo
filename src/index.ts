import express, { Express, Request, Response } from "express";
import z, { object } from "zod";
import dotenv from "dotenv";
import {
  ChatPromptTemplate,
  HumanMessagePromptTemplate,
} from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import {
  StringOutputParser,
  StructuredOutputParser,
} from "@langchain/core/output_parsers";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";

dotenv.config();

const app: Express = express();
const port = 3000;

const objective =
  "Create a video about the winner of the most recent champions league";

const PROMPT = `Given an objective, create a step-by-step plan using ONLY the abilities listed below. 
Each step must correspond to exactly one ability and include a clear description of what needs to be done and what output is expected.

### Abilities
{abilities}

### Objective
{objective}

### Instructions
1. Use ONLY the abilities listed above
2. Each step must:
   - Map to exactly one ability
   - Explain what action to perform and what input parameters to use
   - Reference any data from previous steps explicitly
3. The final step's output must achieve the objective
4. Do not add explanatory or supplementary steps
5. Do not assume abilities that aren't listed

Remember, only use the provided abilities to create the step-by-step plan.

Today's date: 17th of December 2024

{format_instructions}

### Your Plan:`;

export const SYSTEM_PROMPT = `You are a helpful AI assistant designed to provide clear, direct responses to user queries.

Key Instructions:
1. Provide responses directly without meta-commentary, explanations of your process, or unnecessary acknowledgments
2. Do not preface responses with phrases like "Here's your response" or "I'll help you with that"
3. Do not conclude responses with questions about satisfaction or offers for further assistance
4. Stay focused on the specific task or query presented
5. If you need clarification, ask concise, specific questions

Today's date: 17th of December 2024

Remember: Your role is to provide accurate, helpful responses in the most direct manner possible. Do not add pleasantries, meta-commentary, or explanations about your own behavior.`;

app.get("/simple", async (req: Request, res: Response) => {
  const planSchema = z.object({
    steps: z
      .array(z.string())
      .describe("different steps to follow, should be in sorted order"),
  });

  const planOutputParser = StructuredOutputParser.fromZodSchema(planSchema);

  const promptMessages = ChatPromptTemplate.fromMessages([
    HumanMessagePromptTemplate.fromTemplate(PROMPT),
  ]);

  const chatModel = new ChatOpenAI({
    modelName: "gpt-4o",
    temperature: 0.2,
  });

  const chain = RunnableSequence.from([
    promptMessages,
    chatModel,
    planOutputParser,
  ]);

  const abilities = ["search_internet(query)", "send_tweet(text)"];

  const response = await chain.invoke({
    objective: objective,
    abilities: abilities.join("\n"),
    format_instructions: planOutputParser.getFormatInstructions(),
  });

  for (const step of response.steps) {
    console.log(step);
  }

  res.send(response);
});

app.get("/tools", async (req: Request, res: Response) => {
  const searchInternetToolSchema = z.object({
    query: z
      .string()
      .describe("the search query to use to search the internet"),
  });

  const searchInternet = tool(
    async ({ query }) => {
      // fetch(google.com)
      // perplexity.api

      return [
        `The winner of the most recent champions league is Real Madrid.`,
        {
          teamId: 123,
        },
      ];
    },
    {
      name: "search_internet",
      description:
        "searches the internet for up to date information given a query",
      schema: searchInternetToolSchema,
      responseFormat: "content_and_artifact",
    }
  );

  const sendTweetToolSchema = z.object({
    tweetText: z.string().describe("the text of the tweet"),
  });

  const sendTweet = tool(
    async ({ tweetText }) => {
      // twitteApi.postTweet(tweetText)

      return [
        `Tweet posted succesfully!`,
        {
          tweetId: "123",
        },
      ];
    },
    {
      name: "send_tweet",
      description: "posts a tweet online given some text",
      schema: sendTweetToolSchema,
      responseFormat: "content_and_artifact",
    }
  );

  const createVideoSchema = z.object({
    script: z.string().describe("the text of video"),
  });

  const createVideo = tool(
    async ({ script }) => {
      const renderPayload = {
        aspectRatio: "1/1",
        withCaption: false,
        brainrot: false,
        scenes: [
          {
            text: script,
            background: {
              type: "image",
              source: `${process.env.HOLOWORLD_VIDEO_SERVER_BASE_URL}/images/neon.png`,
            },
            voiceId: "GVG9vYrd7AzWuz0Aw0ZJ",
            includeOutro: true,
            modelConfig: {
              id: "ava",
              scale: 0.2,
              x: null, // Center
              y: -75,
            },
          },
        ],
      };

      // Generate video from server
      const res = await fetch(
        `${process.env.HOLOWORLD_VIDEO_SERVER_BASE_URL}/renders`,
        {
          method: "POST",
          headers: {
            "x-api-key": process.env.HOLO_VIDEO_SERVER_API_KEY || "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(renderPayload),
        }
      );

      if (!res.ok) {
        const errorData = await res.text();
        throw new Error(
          `HTTP Error while retrieving video from holo video server ${res.status}: ${errorData}`
        );
      }

      const resData = await res.json();
      const renderId = resData.id;

      // Await for the video to be completed!
      let url = "";
      while (true) {
        const response = await fetch(
          `${process.env.HOLOWORLD_VIDEO_SERVER_BASE_URL}/api/renders/${renderId}`,
          {
            method: "GET",
            headers: {
              "x-api-key": process.env.HOLO_VIDEO_SERVER_API_KEY || "",
            },
          }
        );

        if (!response.ok) {
          const errorData = await response.text();
          throw new Error(
            `HTTP error while polling video render status! status: ${response.status} data: ${errorData}`
          );
        }

        const data = await response.json();

        if (data.status === "completed") {
          url = data.url;
          break;
        }

        if (data.status === "failed") {
          throw new Error(
            `Failed to render video! Reason: ${data.errorMessage}`
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      return [
        `url for the video is! ${url}`,
        {
          videoId: "123",
        },
      ];
    },
    {
      name: "create_video",
      description: "generate a video with a script",
      schema: createVideoSchema,
      responseFormat: "content_and_artifact",
    }
  );

  const TOOLS = [searchInternet, createVideo];

  const ReactGraph = Annotation.Root({
    messages: Annotation<BaseMessage[]>(),
    // Add more here...
  });

  async function callModel(
    state: typeof ReactGraph.State
  ): Promise<typeof ReactGraph.Update> {
    const chatModel = new ChatOpenAI({
      model: "gpt-4o",
    });

    const model = chatModel.bindTools(TOOLS);

    const response = await model.invoke([
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      ...state.messages,
    ]);

    // We return a list, because this will get added to the existing list
    return { messages: [...state.messages, response] };
  }

  function routeModelOutput(state: typeof ReactGraph.State): string {
    const messages = state.messages;

    const lastMessage = messages[messages.length - 1];
    // If the LLM is invoking tools, route there.
    if ((lastMessage as AIMessage)?.tool_calls?.length || 0 > 0) {
      return "tools";
    }
    // Otherwise end the graph.
    else {
      return END;
    }
  }

  async function callTool(state: typeof ReactGraph.State) {
    const toolNodeResponse = await new ToolNode(TOOLS).invoke(state);

    return {
      messages: [...state.messages, ...toolNodeResponse.messages],
    };
  }

  const workflow = new StateGraph(ReactGraph)
    // Define the two nodes we will cycle between
    .addNode("callModel", callModel)
    .addNode("tools", callTool)
    .addEdge(START, "callModel")
    .addConditionalEdges("callModel", routeModelOutput)
    .addEdge("tools", "callModel");

  const reACT = workflow.compile();

  const messages: any[] = [
    {
      role: "user",
      content: objective,
    },
  ];

  const inputs: typeof ReactGraph.State = {
    messages: messages,
  };

  const response = await reACT.invoke(inputs);

  res.send(response);
});

const server = app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    console.log("Server shutting down");
  });
});
