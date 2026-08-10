"""Automatic marketplace listing (自动上架) executor.

Walks the same click chain the player uses in-game:
topbar trade tab → market button → my list tab → click stash item →
enter price (backspace + type) → list item button → confirm popup.
All coordinates come from ``macros.get_market_positions()`` (layout
defaults + calibration overrides) and the shared stash anchor.
"""
import logging
import time

from dnd.sort import macros

logger = logging.getLogger(__name__)

# Backspace count used to clear the price input before typing a new price.
PRICE_CLEAR_BACKSPACES = 10

# Anchors required for the full single-item flow, in click order.
_ENTER_ANCHORS = ('topbar_trade', 'market_btn', 'mylist_tab')
_PRICE_ANCHORS = ('price_input',)
_CONFIRM_ANCHORS = ('sell_list_btn', 'confirm_btn')


def _require_anchors(anchors, keys):
    missing = [k for k in keys if k not in anchors]
    if missing:
        raise ValueError("market_anchors_missing:" + ",".join(missing))


def _enter_market(anchors):
    """Steps 1-3: trade-hall topbar tab → market button → my-list tab."""
    macros.click_at(anchors['topbar_trade'].x, anchors['topbar_trade'].y, settle=0.3)
    logger.debug("sell: clicked topbar_trade at (%d, %d)",
                 anchors['topbar_trade'].x, anchors['topbar_trade'].y)
    macros._sleep_with_cancel(1.0)  # let the trade-hall page render
    macros.click_at(anchors['market_btn'].x, anchors['market_btn'].y, settle=0.35)
    logger.debug("sell: clicked market_btn at (%d, %d)",
                 anchors['market_btn'].x, anchors['market_btn'].y)
    macros._sleep_with_cancel(1.2)  # let the market channel load
    macros.click_at(anchors['mylist_tab'].x, anchors['mylist_tab'].y, settle=0.3)
    logger.debug("sell: clicked mylist_tab at (%d, %d)",
                 anchors['mylist_tab'].x, anchors['mylist_tab'].y)
    macros._sleep_with_cancel(1.0)  # let the my-list panel render


def _click_item(cx, cy):
    """Step 4: click the item cell inside the market-page stash grid."""
    macros.click_at(cx, cy, settle=0.25)
    logger.debug("sell: clicked item at (%.1f, %.1f)", cx, cy)
    macros._sleep_with_cancel(0.8)  # let the item get selected


def _enter_price(anchors, price):
    """Step 5: click the price input, clear it, type the price."""
    macros.click_at(anchors['price_input'].x, anchors['price_input'].y, settle=0.15)
    macros._sleep_with_cancel(0.5)  # let the input field focus
    macros.press_backspace(PRICE_CLEAR_BACKSPACES)
    macros.type_text(str(int(price)))
    logger.debug("sell: entered price %d at (%d, %d)",
                 price, anchors['price_input'].x, anchors['price_input'].y)


def _confirm_sell(anchors):
    """Steps 6-7: click the list button, then the confirmation button."""
    macros.click_at(anchors['sell_list_btn'].x, anchors['sell_list_btn'].y, settle=0.3)
    logger.debug("sell: clicked sell_list_btn at (%d, %d)",
                 anchors['sell_list_btn'].x, anchors['sell_list_btn'].y)
    macros._sleep_with_cancel(1.0)  # let the confirmation popup appear
    macros.click_at(anchors['confirm_btn'].x, anchors['confirm_btn'].y, settle=0.35)
    logger.debug("sell: clicked confirm_btn at (%d, %d)",
                 anchors['confirm_btn'].x, anchors['confirm_btn'].y)
    macros._sleep_with_cancel(1.0)  # let the listing complete


def sell_items(items, cancel_event=None, progress=None):
    """List multiple items in click order.

    ``items`` is a list of dicts: ``{'stash_id': str, 'x': int, 'y': int,
    'w': int, 'h': int, 'price': int}`` where (x, y) is the cell position
    of the item's top-left corner inside the stash grid.

    Steps 1-3 run once before the first item; the stash tab is clicked
    whenever the item's stash_id differs from the previous item's.

    Returns a result dict; raises nothing but ``MacroCancelled`` is caught
    into ``{'success': False, 'error': 'cancelled'}``.
    """
    if cancel_event is not None:
        macros.push_cancel_event(cancel_event)
    try:
        logger.info("sell_items: start, %d items", len(items))
        if not macros.force_activate_game_window():
            return {"success": False, "error": "no_window"}

        anchors = macros.get_market_positions()
        _require_anchors(anchors, _ENTER_ANCHORS + _PRICE_ANCHORS + _CONFIRM_ANCHORS)

        positions = macros.get_screen_positions()
        stash_base = positions['stash']
        jump = float(positions['jump'])

        results = []
        entered = False
        current_stash = None
        total = len(items)
        for index, item in enumerate(items):
            macros._ensure_not_cancelled()

            if not entered:
                _enter_market(anchors)
                entered = True

            stash_id = str(item.get('stash_id', ''))
            if stash_id and stash_id != current_stash:
                try:
                    # Market page stash tabs are bag-first: reuse the shared
                    # origin/spacing but click via the market mapping.
                    macros.click_market_stash_tab(int(stash_id))
                except (TypeError, ValueError):
                    logger.warning("sell_items: bad stash_id %r", stash_id)
                current_stash = stash_id
                macros._sleep_with_cancel(1.0)  # let the stash panel render

            cx = stash_base.x + jump * int(item['x']) + jump * int(item.get('w', 1)) / 2
            cy = stash_base.y + jump * int(item['y']) + jump * int(item.get('h', 1)) / 2
            price = int(item.get('price', 0))

            _click_item(cx, cy)
            _enter_price(anchors, price)
            _confirm_sell(anchors)

            results.append({
                "index": index,
                "stash_id": stash_id,
                "price": price,
            })
            if progress:
                progress(index + 1, total)
            logger.info("sell_items: listed item %d/%d (stash %s, price %d)",
                        index + 1, total, stash_id, price)

        return {"success": True, "total": total, "results": results}
    except macros.MacroCancelled:
        logger.info("sell_items: cancelled")
        return {"success": False, "error": "cancelled"}
    finally:
        if cancel_event is not None:
            macros.pop_cancel_event(cancel_event)
