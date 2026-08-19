"""Repository-owned deterministic-shape workflow used by SwarmFlow Executor V1."""

from __future__ import annotations

from swarmflow import agent, log, phase


META = {
    "name": "visualization-two-phase",
    "description": "Understand one input, then synthesize a final response with a second worker.",
    "phases": [
        {
            "title": "Understand Input",
            "description": "A dedicated worker extracts intent, constraints, and important evidence.",
        },
        {
            "title": "Synthesize Response",
            "description": "A second worker combines the input and prior analysis into the final answer.",
        },
    ],
}


def _guidance(args: dict) -> str:
    value = args.get("system_prompt")
    if not isinstance(value, str) or not value.strip():
        return "No additional response guidance was supplied."
    return "Additional response guidance:\n" + value.strip()


async def run(args):
    data = args if isinstance(args, dict) else {}
    input_text = str(data.get("input") or "")
    guidance = _guidance(data)

    phase("Understand Input")
    analysis = await agent(
        "\n\n".join(
            (
                "Analyze the user input. Identify the request, constraints, assumptions, and the "
                "facts that the response worker must preserve. Do not claim to use tools or files.",
                guidance,
                "USER INPUT:\n" + input_text,
            )
        ),
        label="Analysis Worker",
        phase="Understand Input",
    )
    log("Analysis Worker completed the understanding phase.")

    phase("Synthesize Response")
    final = await agent(
        "\n\n".join(
            (
                "Produce the final response to the user. Follow the additional guidance, preserve "
                "the original request, and use the prior worker analysis as supporting context. "
                "Do not mention this internal workflow unless the user asks about it.",
                guidance,
                "USER INPUT:\n" + input_text,
                "PRIOR WORKER ANALYSIS:\n" + str(analysis or ""),
            )
        ),
        label="Response Worker",
        phase="Synthesize Response",
    )
    log("Response Worker completed the synthesis phase.")
    return {
        "analysis": str(analysis or ""),
        "final": str(final or ""),
    }
