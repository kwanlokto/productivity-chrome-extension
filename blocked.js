// Populate the blocked page with the domain and a random inspirational quote.
const QUOTES = [
  { text: "The successful warrior is the average man, with laser-like focus.", author: "Bruce Lee" },
  { text: "It's not enough to be busy; the question is: what are we busy about?", author: "Henry David Thoreau" },
  { text: "Where focus goes, energy flows.", author: "Tony Robbins" },
  { text: "Concentrate all your thoughts upon the work at hand.", author: "Alexander Graham Bell" },
  { text: "Discipline is choosing between what you want now and what you want most.", author: "Abraham Lincoln" },
  { text: "The future depends on what you do today.", author: "Mahatma Gandhi" },
  { text: "You don't have to see the whole staircase, just take the first step.", author: "Martin Luther King Jr." },
  { text: "Amateurs sit and wait for inspiration, the rest of us just get up and go to work.", author: "Stephen King" },
  { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
  { text: "Either you run the day or the day runs you.", author: "Jim Rohn" },
  { text: "Do the hard jobs first. The easy jobs will take care of themselves.", author: "Dale Carnegie" },
  { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
  { text: "Action is the foundational key to all success.", author: "Pablo Picasso" },
  { text: "Your time is limited, so don't waste it living someone else's life.", author: "Steve Jobs" },
  { text: "Lost time is never found again.", author: "Benjamin Franklin" },
  { text: "Start where you are. Use what you have. Do what you can.", author: "Arthur Ashe" },
  { text: "Quality is not an act, it is a habit.", author: "Aristotle" },
  { text: "Well done is better than well said.", author: "Benjamin Franklin" },
  { text: "Motivation gets you going, but discipline keeps you growing.", author: "John C. Maxwell" },
  { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" }
];

const params = new URLSearchParams(location.search);
const domain = params.get("domain");
if (domain) {
  document.getElementById("domain").textContent = domain;
}

const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
const quoteEl = document.getElementById("quote");
quoteEl.textContent = "“" + quote.text + "”";
const authorEl = document.createElement("span");
authorEl.className = "author";
authorEl.textContent = "— " + quote.author;
quoteEl.appendChild(document.createElement("br"));
quoteEl.appendChild(authorEl);

document.getElementById("back").addEventListener("click", (e) => {
  e.preventDefault();
  if (history.length > 1) {
    history.back();
  } else {
    location.href = "https://www.google.com";
  }
});
