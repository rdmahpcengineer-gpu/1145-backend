"""Backend SE-1 receiving end — the real ``Se1Bridge`` servicer (not the echo stub).

This is the AWS/AgentCore end of the SE-1 seam. The middleware streams
``se1.Utterance`` messages over gRPC; this servicer decodes them using the
**imported, generated** ``alchemist_contracts`` code — the SAME wire types the
middleware sends — and streams back ``se1.ReplyText``. Because both ends import
the published contract (``alchemist-contracts==0.1.0``), the bytes on the wire
decode without a parallel hand-rolled definition: that shared-generated-code
guarantee is exactly what the published seam buys.

Run it:  ``python -m agentcore.session.se1_server``  (defaults to port 50551;
override with ``SE1_PORT``). Kept deliberately thin — real reasoning lives
elsewhere in AgentCore; this module only proves/handles the wire decode.
"""

from __future__ import annotations

import asyncio
import os
from typing import AsyncIterator

# Generated SE-1 wire types + gRPC stubs, re-exported from the imported contract.
from agentcore.contracts import se1, se1_grpc

#: SE-1 proto message full name — used to assert a real decode on the wire.
SE1_UTTERANCE_FULL_NAME = "alchemist.v0.Utterance"


class Se1Bridge(se1_grpc.Se1BridgeServicer):
    """Decodes inbound SE-1 utterances and replies with generated ``ReplyText``."""

    async def StreamUtterances(
        self, request_iterator: AsyncIterator["se1.Utterance"], context
    ) -> AsyncIterator["se1.ReplyText"]:
        async for utt in request_iterator:
            # Decoded as the imported alchemist.v0.Utterance — no parse error,
            # no local re-declaration. The agent acts on stable (final) segments.
            if not utt.is_final:
                continue
            yield se1.ReplyText(
                tenant_id=utt.tenant_id,
                call_id=utt.call_id,
                seq=utt.seq,
                text=f"[agentcore] booked intent heard: {utt.text}",
                end_of_turn=True,
                barge_in_ok=True,
            )

    async def ReportCallEvent(
        self, request: "se1.CallEvent", context
    ) -> "se1.CallEventAck":
        return se1.CallEventAck(call_id=request.call_id, accepted=True)


async def serve(port: int) -> None:
    import grpc

    server = grpc.aio.server()
    se1_grpc.add_Se1BridgeServicer_to_server(Se1Bridge(), server)
    server.add_insecure_port(f"[::]:{port}")
    await server.start()
    await server.wait_for_termination()


def main() -> None:
    asyncio.run(serve(int(os.environ.get("SE1_PORT", "50551"))))


if __name__ == "__main__":
    main()
