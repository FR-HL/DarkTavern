import logging
from fastapi import APIRouter, Query

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("")
def list_packets(page: int = Query(0, ge=0), page_size: int = Query(50, ge=1, le=200)):
    from dnd.service import get_packet_capture
    capture = get_packet_capture()
    packets = list(capture.captured_packets)
    packets.reverse()
    total = len(packets)
    start = page * page_size
    end = start + page_size
    page_items = packets[start:end]

    result = []
    for pkt in page_items:
        result.append({
            "id": pkt.get("id"),
            "timestamp": pkt.get("timestamp"),
            "type": pkt.get("type"),
            "proto_type": pkt.get("proto_type"),
            "raw_length": pkt.get("raw_length"),
            "parsed": pkt.get("parsed"),
            "handled": pkt.get("handled"),
        })

    return {"total": total, "page": page, "page_size": page_size, "packets": result}


@router.get("/{packet_id}")
def get_packet_detail(packet_id: int):
    from dnd.service import get_packet_capture
    capture = get_packet_capture()
    for pkt in capture.captured_packets:
        if pkt.get("id") == packet_id:
            return pkt
    return {"error": "Packet not found"}


@router.post("/clear")
def clear_packets():
    from dnd.service import get_packet_capture
    capture = get_packet_capture()
    capture.captured_packets.clear()
    return {"success": True}
