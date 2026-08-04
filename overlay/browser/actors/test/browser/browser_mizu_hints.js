/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PAGE =
  getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com"
  ) + "file_mizu_hints.html";

/** The labels currently drawn in the page, read out of the closed shadow root. */
function labels(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    let host = content.document.getElementById("mizu-link-hints-host");
    if (!host) {
      return null;
    }
    return Array.from(
      host.openOrClosedShadowRoot.querySelectorAll(".hint:not([hidden])"),
      node => node.textContent
    );
  });
}

function clicked(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    content.wrappedJSObject.clicked.slice()
  );
}

async function openHints(browser, options = {}) {
  EventUtils.synthesizeKey("g", { ctrlKey: true, ...options }, window);
  await TestUtils.waitForCondition(
    () => MizuLinkHints._active,
    "a hint session started"
  );
  await TestUtils.waitForCondition(
    async () => (await labels(browser))?.length,
    "labels were drawn in the page"
  );
}

function type(text) {
  for (let char of text) {
    EventUtils.synthesizeKey(char.toLowerCase(), {}, window);
  }
}

add_task(async function activates_each_kind_of_control() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    // The page holds an <a>, a <button> and a bare <div> whose only claim to
    // being clickable is an addEventListener call, in that visual order.
    for (let [position, id] of [
      [0, "link"],
      [1, "button"],
      [2, "widget"],
    ]) {
      await openHints(browser);

      let drawn = await labels(browser);
      is(drawn.length, 23, `every control on the page is labelled (${id})`);
      ok(
        drawn.some(label => label.length > 1),
        "the alphabet ran out and labels grew a second character"
      );

      let hint = MizuLinkHints._hints[position];
      ok(hint, `${id} has a hint`);
      type(hint.label);

      await TestUtils.waitForCondition(
        async () => (await clicked(browser)).includes(id),
        `typing ${hint.label} activated ${id}`
      );
      await TestUtils.waitForCondition(
        () => !MizuLinkHints._active,
        "the session ended after activation"
      );
      await TestUtils.waitForCondition(
        async () => !(await labels(browser)),
        "the labels were removed from the page"
      );
    }
  });
});

add_task(async function escape_cancels_without_clicking() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openHints(browser);

    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForCondition(
      () => !MizuLinkHints._active,
      "escape ended the session"
    );
    await TestUtils.waitForCondition(
      async () => !(await labels(browser)),
      "escape removed the labels"
    );
    Assert.deepEqual(await clicked(browser), [], "nothing was clicked");
  });
});

add_task(async function typing_narrows_to_a_unique_label() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openHints(browser);

    // Labels are prefix free, so a first character that several share must
    // filter rather than fire.
    let all = MizuLinkHints._hints.map(hint => hint.label);
    let shared = all.find(label => label.length > 1);
    if (!shared) {
      info(`no multi-character label in ${all.join(" ")}, nothing to narrow`);
      EventUtils.synthesizeKey("KEY_Escape", {}, window);
      return;
    }

    type(shared[0]);
    ok(MizuLinkHints._active, "a partial label did not activate anything");
    Assert.deepEqual(await clicked(browser), [], "nothing was clicked yet");

    let visible = await labels(browser);
    Assert.less(
      visible.length,
      all.length,
      `typing ${shared[0]} hid the labels that no longer match`
    );

    EventUtils.synthesizeKey("KEY_Escape", {}, window);
    await TestUtils.waitForCondition(
      () => !MizuLinkHints._active,
      "escape ended the session"
    );
  });
});

add_task(async function page_never_sees_the_typed_label() {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    await openHints(browser);

    let hint = MizuLinkHints._hints[1];
    type(hint.label);
    await TestUtils.waitForCondition(
      () => !MizuLinkHints._active,
      "the session ended"
    );

    let keys = await SpecialPowers.spawn(browser, [], () =>
      content.wrappedJSObject.keys.slice()
    );
    Assert.deepEqual(keys, [], "the page received none of the typed keys");
  });
});
