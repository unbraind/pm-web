(function () {
  var storageKey = "pm_cookie_preferences_v1";
  var banner = document.getElementById("cookie-consent");
  var links = document.querySelectorAll("[data-cookie-settings]");

  function save(choice) {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ necessary: true, optional: false, choice: choice, savedAt: new Date().toISOString() }));
    } catch (_) {
      /* ignore unavailable storage */
    }
  }

  function hasChoice() {
    try {
      return Boolean(localStorage.getItem(storageKey));
    } catch (_) {
      return false;
    }
  }

  function show(event) {
    if (event) event.preventDefault();
    if (banner) banner.hidden = false;
  }

  function hide() {
    if (banner) banner.hidden = true;
  }

  links.forEach(function (link) {
    link.addEventListener("click", show);
  });

  document.querySelectorAll("[data-cookie-accept], [data-cookie-decline]").forEach(function (button) {
    button.addEventListener("click", function () {
      save(button.hasAttribute("data-cookie-accept") ? "acknowledged" : "necessary");
      hide();
    });
  });

  if (!hasChoice()) show();
})();
