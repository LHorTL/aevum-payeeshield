import functools
import http.server
import os
import socketserver
import sys
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT / "web" / "dist"
SCREENSHOT_DIR = Path(os.environ.get("E2E_SCREENSHOT_DIR", "")) if os.environ.get("E2E_SCREENSHOT_DIR") else None


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def start_static_server(directory: Path):
    handler = functools.partial(QuietHandler, directory=str(directory))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, port


def run():
    if not (DIST_DIR / "index.html").exists():
        print(f"ERROR: {DIST_DIR / 'index.html'} not found. Run `npm run web:build` first.")
        sys.exit(1)

    if SCREENSHOT_DIR:
        SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    httpd, port = start_static_server(DIST_DIR)
    url = f"http://127.0.0.1:{port}/"
    console_errors = []
    page_errors = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)

            # ---- Desktop 1440x900 full E2E flow ----
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda err: page_errors.append(str(err)))

            page.goto(url, wait_until="networkidle")
            assert "PayeeShield" in page.title(), f"Unexpected title: {page.title()}"
            assert page.get_by_test_id("cop-verdict").inner_text().strip() == "EXACT_MATCH"
            if SCREENSHOT_DIR:
                page.screenshot(path=str(SCREENSHOT_DIR / "desktop_cop_exact.png"), full_page=True)

            # Test all CoP attack presets
            page.get_by_role("button", name="Close Match (Entity Diff)").click()
            assert page.get_by_test_id("cop-verdict").inner_text().strip() == "CLOSE_MATCH_WARNING"

            page.get_by_role("button", name="Lookalike Spoof (acrne.cloud)").click()
            assert page.get_by_test_id("cop-verdict").inner_text().strip() == "UNREGISTERED"
            assert page.get_by_text("Lookalike Spoof Detected:").is_visible()
            if SCREENSHOT_DIR:
                page.screenshot(path=str(SCREENSHOT_DIR / "desktop_cop_spoof.png"), full_page=False)

            page.get_by_role("button", name="Cyrillic Homoglyph").click()
            assert page.get_by_test_id("cop-verdict").inner_text().strip() == "NO_MATCH"
            assert page.get_by_text("InvalidHandle()").is_visible()

            page.get_by_role("button", name="Revoked Payee").click()
            assert page.get_by_test_id("cop-verdict").inner_text().strip() == "PAYEE_REVOKED"

            # Switch to Invoice Queue tab -> verify spoof block, revoked block, valid 3-way split settle, and emergency refund
            page.get_by_role("tab", name="Invoice Queue & Pay").click()
            # Trigger spoofed BEC invoice #103 block
            spoof_card = page.locator("article.invoice-card", has_text="#103 · INV-SPOOF-BEC-0103")
            spoof_card.get_by_role("button", name="Attempt Payment").click()
            assert spoof_card.get_by_text("REVERT PayeeMismatch(NO_MATCH)").is_visible()

            # Trigger revoked vendor invoice #104 block
            revoked_card = page.locator("article.invoice-card", has_text="#104 · INV-REVOKED-0104")
            revoked_card.get_by_role("button", name="Attempt Payment").click()
            assert revoked_card.get_by_text("REVERT PayeeRevoked(5)").is_visible()

            # Settle valid 3-way split invoice #101
            valid_card = page.locator("article.invoice-card", has_text="#101 · INV-2026-Q4-0101")
            valid_card.get_by_role("button", name="Verify CoP & Pay").click()
            assert valid_card.get_by_text("Deterministic On-Chain Receipt Hash:").is_visible()

            # On funded escrow #102, simulate compromise -> execute emergency 100% buyer refund
            escrow_card = page.locator("article.invoice-card", has_text="#102 · INV-2026-ESC-0102")
            escrow_card.get_by_role("button", name="Simulate Post-Funding Payee Compromise").click()
            escrow_card.get_by_role("button", name="Execute Emergency 100% Buyer Refund").click()
            assert escrow_card.locator(".badge", has_text="REFUNDED").is_visible()
            if SCREENSHOT_DIR:
                page.screenshot(path=str(SCREENSHOT_DIR / "desktop_invoices.png"), full_page=True)

            # Switch to Issue Split Invoice tab & create a new invoice
            page.get_by_role("tab", name="Issue Split Invoice").click()
            page.get_by_role("button", name="Create CoP-Bound Invoice").click()
            assert page.locator("article.invoice-card", has_text="#105").is_visible()

            # Switch to ERC-8004 Registry tab -> test homoglyph rejection + valid ASCII registration
            page.get_by_role("tab", name="ERC-8004 Registry").click()
            page.locator("#reg-handle").fill("\u0430cme.cloud")
            page.locator("#reg-legal").fill("Spoof Entity")
            page.get_by_role("button", name="Register ERC-8004 Payee").click()
            assert page.get_by_text("REVERT InvalidHandle()").is_visible()

            page.locator("#reg-handle").fill("solaris.logistics")
            page.locator("#reg-legal").fill("Solaris Logistics GmbH")
            page.get_by_role("button", name="Register ERC-8004 Payee").click()
            assert page.get_by_text("Minted ERC-8004 Identity NFT #6").is_visible()

            # Switch to Aevum Live (44005) mode & confirm banner + live wallet auto-switch render cleanly
            page.get_by_role("tab", name="CoP Inspector").click()
            page.get_by_role("button", name="Exact Match (acme.cloud)").click()
            assert page.locator("#cop-wallet").input_value() == "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
            page.get_by_role("button", name="Aevum Live (44005)").click()
            assert page.get_by_text("QDay Aevum Testnet (Chain ID 44005)", exact=True).is_visible()
            assert page.locator("#cop-wallet").input_value() == "0xB15f90BaB6BBc6f090D7522c4CFf3070CaFac856"
            assert page.get_by_test_id("cop-verdict").inner_text().strip() == "AWAITING_RPC_QUERY"
            page.get_by_role("button", name="Close Match (Entity Diff)").click()
            assert page.locator("#cop-wallet").input_value() == "0xB15f90BaB6BBc6f090D7522c4CFf3070CaFac856"
            page.get_by_role("button", name="Exact Match (acme.cloud)").click()
            page.get_by_role("button", name="Interactive Simulation").click()
            assert page.locator("#cop-wallet").input_value() == "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
            assert page.get_by_test_id("cop-verdict").inner_text().strip() == "EXACT_MATCH"
            page.get_by_role("button", name="Aevum Live (44005)").click()

            # ---- Mobile 390x844 responsive check across ALL tabs + Live mode ----
            mctx = browser.new_context(viewport={"width": 390, "height": 844})
            mpage = mctx.new_page()
            mpage.on("console", lambda msg: console_errors.append(f"[mobile] {msg.text}") if msg.type == "error" else None)
            mpage.on("pageerror", lambda err: page_errors.append(f"[mobile] {err}"))

            def assert_no_mobile_overflow(view_label: str):
                metrics = mpage.evaluate("({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })")
                assert metrics["sw"] <= metrics["iw"] + 2, (
                    f"Detected horizontal overflow on 390px mobile viewport in {view_label}: "
                    f"scrollWidth={metrics['sw']} > innerWidth={metrics['iw']}"
                )

            mpage.goto(url, wait_until="networkidle")
            assert mpage.get_by_test_id("cop-verdict").inner_text().strip() == "EXACT_MATCH"
            assert_no_mobile_overflow("Tab 1: CoP Inspector")
            if SCREENSHOT_DIR:
                mpage.screenshot(path=str(SCREENSHOT_DIR / "mobile_cop.png"), full_page=True)

            mpage.get_by_role("tab", name="Invoice Queue & Pay").click()
            assert_no_mobile_overflow("Tab 2: Invoice Queue & Pay")
            if SCREENSHOT_DIR:
                mpage.screenshot(path=str(SCREENSHOT_DIR / "mobile_invoices.png"), full_page=True)

            mpage.get_by_role("tab", name="Issue Split Invoice").click()
            assert_no_mobile_overflow("Tab 3: Issue Split Invoice")

            mpage.get_by_role("tab", name="ERC-8004 Registry").click()
            assert_no_mobile_overflow("Tab 4: ERC-8004 Registry")

            mpage.get_by_role("button", name="Aevum Live (44005)").click()
            assert mpage.get_by_text("QDay Aevum Testnet (Chain ID 44005)", exact=True).is_visible()
            assert_no_mobile_overflow("Aevum Live (44005)")

            browser.close()
    finally:
        httpd.shutdown()

    assert len(console_errors) == 0, f"Console errors detected: {console_errors}"
    assert len(page_errors) == 0, f"Page errors detected: {page_errors}"
    print("E2E_SMOKE_PASS: Desktop (1440x900) + Mobile (390x844) rendered with 0 console errors and 0 page errors.")


if __name__ == "__main__":
    run()
