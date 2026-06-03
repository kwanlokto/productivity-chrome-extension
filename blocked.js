// Populate the blocked page with the domain and a rotating quote.
const QUOTES = [
  "The successful warrior is the average man, with laser-like focus.",
  "It's not enough to be busy; the question is: what are we busy about?",
  "Where focus goes, energy flows.",
  "You will never reach your destination if you stop to throw stones at every dog that barks.",
  "Concentrate all your thoughts upon the work at hand.",
  "Discipline is choosing between what you want now and what you want most."
];

const params = new URLSearchParams(location.search);
const domain = params.get("domain");
if (domain) {
  document.getElementById("domain").textContent = domain;
}

document.getElementById("quote").textContent =
  '“' + QUOTES[Math.floor(Math.random() * QUOTES.length)] + '”';

document.getElementById("back").addEventListener("click", (e) => {
  e.preventDefault();
  if (history.length > 1) {
    history.back();
  } else {
    location.href = "https://www.google.com";
  }
});
