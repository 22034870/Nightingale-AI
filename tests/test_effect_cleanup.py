"""
test_effect_cleanup.py — guards against the bug that broke every chat session.

THE BUG
-------
    useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

A concise-body arrow RETURNS the value of the call. React stores an effect's
return value as its CLEANUP function. Chrome 152 began returning a
scroll-completion Promise from scrollIntoView(), so React stored a Promise and
then invoked it as cleanup the first time `messages` changed — the first time
anyone pressed Send.

Calling a Promise throws. It throws in React's COMMIT phase, which a render
retry cannot recover, so React tore down the whole root and Next.js swapped in
its built-in global error page:

    "This page couldn't load — Reload to try again, or go back."

Which looks exactly like a browser crash and is not one. chrome://crashes was
empty because nothing crashed. The POST to /api/chat completed successfully
*after* the UI was already gone.

WHY NOTHING ELSE CAUGHT IT
--------------------------
tsc cannot: lib.dom.d.ts still declares `scrollIntoView(): void`, and `void` is
assignable to `void | Destructor`. The DOM lib lags browsers by months.

React does warn — "must not return anything besides a function, which is used
for clean-up" — but only in the development build. Production is silent.

It reproduced on Chrome 152 and not on Chrome 148, which is why it looked
environment-specific rather than like a code defect.

THE RULE
--------
Always give an effect a block body unless you are deliberately returning a
cleanup function. The return type of a DOM method is not a stable contract.
"""

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]

# useEffect( () => X   where X is anything other than an opening brace
CONCISE_EFFECT = re.compile(r"use(?:Layout)?Effect\(\s*\(\s*\)\s*=>\s*(.)")

# Comments legitimately contain the bad pattern — the fix in ChatClient.tsx is
# documented with an example of it. Strip comments before scanning, or the
# guard fires on the explanation of the very bug it guards against.
LINE_COMMENT = re.compile(r"//[^\n]*")
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)


def _strip_comments(text: str) -> str:
    """Blank out comments, preserving newlines so line numbers stay accurate."""
    text = BLOCK_COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    return LINE_COMMENT.sub("", text)


def _sources():
    for directory in ("app", "components", "lib"):
        base = ROOT / directory
        if base.exists():
            yield from base.rglob("*.tsx")
            yield from base.rglob("*.ts")


def test_effects_use_a_block_body():
    """
    A concise-body effect returns whatever its expression evaluates to, and
    React calls that as cleanup. Even when today's return type is void,
    tomorrow's browser may change it — which is exactly what happened.
    """
    offenders = []
    for path in _sources():
        text = _strip_comments(path.read_text(encoding="utf-8"))
        for match in CONCISE_EFFECT.finditer(text):
            if match.group(1) != "{":
                line = text[: match.start()].count("\n") + 1
                offenders.append(f"{path.relative_to(ROOT)}:{line}")

    assert not offenders, (
        "useEffect/useLayoutEffect must use a block body, not `() => expr`.\n"
        "A concise arrow returns the expression, and React calls that as the\n"
        "cleanup function. See this file's docstring.\n  " + "\n  ".join(offenders)
    )


def test_the_specific_scroll_effect_is_still_safe():
    """
    Belt and braces on the exact line that caused it, so a future edit that
    reintroduces the pattern fails with a message naming the history.
    """
    path = ROOT / "app" / "chat" / "ChatClient.tsx"
    if not path.exists():
        return

    text = _strip_comments(path.read_text(encoding="utf-8"))
    assert "scrollIntoView" in text, "the scroll effect disappeared; update this test"
    assert not re.search(r"=>\s*endRef\.current\?\.scrollIntoView", text), (
        "ChatClient.tsx has reverted to a concise-body scroll effect. "
        "Chrome returns a Promise from scrollIntoView(); React will call it as "
        "cleanup and tear down the root on the first message."
    )
