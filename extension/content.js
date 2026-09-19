// Runs inside the page. Returns { title, text } with paragraphs separated by blank lines.
(() => {
  const selection = window.getSelection()?.toString().trim();
  if (selection && selection.length > 200) {
    return { title: document.title, text: selection };
  }
  let title = document.title;
  let html = null;
  try {
    const article = new Readability(document.cloneNode(true)).parse();
    if (article && article.content) {
      title = article.title || title;
      html = article.content;
    }
  } catch (e) {
    // fall through to plain body text
  }
  const holder = document.createElement("div");
  if (html) {
    holder.innerHTML = html;
    // innerText needs the node to be rendered to produce line breaks between blocks.
    holder.style.cssText = "position:absolute;left:-99999px;top:0;width:800px";
    document.body.appendChild(holder);
    const text = holder.innerText;
    holder.remove();
    return { title, text };
  }
  return { title, text: document.body.innerText };
})();
