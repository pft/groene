"use strict";

const fs = require("fs"),
  userdata = require("../config.json"),
  request = require("request").defaults({ jar: true }),
  jsdom = require("jsdom"),
  Url = require("url"),
  path = require("path"),
  cp = require("cp"),
  base = "https://www.groene.nl";

const book = {
  basetitle: "De Groene Amsterdammer",
  categories: ["News"],
  languages: ["nl-NL"],
  creator: {
    name: "Groene Amsterdammer",
    role: "aut",
    "file-as": "Groene Amsterdammer",
  },
  publisher: "NV Weekblad De Groene Amsterdammer",
  css: fs.readFileSync(path.join(__dirname, "style.css"), {
    encoding: "utf-8",
  }),
  issue: Url.resolve("/", process.argv[2] || "/deze-week"), // Can be adjusted later on
  pages: [], // ,
  // authors: new Map(),
};

const fixCrap = (contents, document) => {
  for (let node of contents.querySelectorAll(
    `span.icon, aside, iframe, noscript, .print-only`
  )) {
    node.remove();
  }
  for (let node of contents.querySelectorAll(`a[href="/luisterverhalen"]`)) {
    while (node && node.tagName !== "ARTICLE") {
      node = node.parentNode;
    }
    node && node.remove();
  }
  for (let img of contents.querySelectorAll("img[data-src]")) {
    img.setAttribute("src", img.getAttribute("data-src"));
    img.removeAttribute("data-src");
  }
  for (let img of contents.querySelectorAll("img[src]")) {
    img.setAttribute(
      "src",
      Url.resolve(base, img.getAttribute("src").replace(/\?.*$/, ""))
    );
  }
  for (let sc of contents.querySelectorAll(".small-caps")) {
    let abbr = document.createElement("abbr");
    abbr.textContent = sc.textContent.toUpperCase();
    sc.parentNode.replaceChild(abbr, sc);
  }

  return contents;
};

// @todo: scrape http://www.groene.nl/pagina/colofon for contributors
// and add all authors.  See
// http://www.idpf.org/epub/20/spec/OPF_2.0.1_draft.htm#Section2.2.6
// for roles
// @todo (?) Add tags as subjects.
book.readyForPrinting = function () {
  return (
    book.pages.filter(function (page) {
      return page.body !== undefined;
    }).length === book.pages.length
  );
};

book.getUrl = function () {
  return Url.resolve(base, book.issue);
};

book.setTitle = function () {
  // Set the title
  book.title = book.basetitle + " #" + book.issue.split("/").pop();
};

const Helper = {
  login_url: Url.resolve(base, "accounts/inloggen"),
};

function login() {
  request.get({ uri: Helper.login_url }, function (error, response, body) {
    promiseDOM(body).then(({ window }) => {
      const token_name = `authenticity_token`,
        $token = window.document.querySelector(`input[name=${token_name}]`),
        authenticity_token = $token.value,
        form = {
          authenticity_token,
          "customer[email]": userdata.user,
          "customer[password]": userdata.pass,
          // 'customer[remember_me]' : ,
          // "commit": "Inloggen"
        };
      console.log(`${token_name} → ${authenticity_token}`);
      request.post(
        { uri: Helper.login_url, form, followAllRedirects: true },
        afterLogin
      );
    });
  });
}

function afterLogin(err, res, body) {
  // NOTE the name of the issue *may* change after redirect
  if (Boolean(process.stdout.isTTY))
    console.log(`Downloading issue from ${book.getUrl()}`);
  request.get({ uri: book.getUrl(), followAllRedirects: true }, parseIndex);
}

function notReady(soon) {
  console.warn(`Issue ${book.issue} not (yet) available`);
  if (soon) console.warn(`... but it soon will be`);
  else {
    console.warn(`=========================
To download another issue than the one from this week,
provide this program with the issue number, e.g.:
${process.argv[0]}, ${process.argv[1]}, 2015/17_18 (for a "dubbeldik nummer") or:
${process.argv[0]}, ${process.argv[1]}, 1994/7 (the oldest Groene available at the time of writing)`);
  }
  process.exit(11);
}

function promiseDOM(body, scripts, passon) {
  return new Promise(function (resolve, reject) {
    jsdom.env(body, scripts, function (err, window) {
      if (err) reject(err);
      else {
        resolve({ window, passon });
      }
    });
  });
}

function promiseGET(url) {
  return new Promise(function (resolve, reject) {
    request.get(url, function (err, res) {
      if (err) reject(err);
      else {
        resolve(res);
      }
    });
  });
}

function parseIndex(err, res, body) {
  if (res.statusCode === 404) {
    notReady();
  }
  book.issue = res.request.uri.path;
  book.setTitle();

  promiseDOM(body, [])
    .then(({ window }) => setCover(window))
    .then(setInitialToc)
    .then(getLinks)
    .then((links) => [...new Set(links)]) // remove dupes
    // .then(links => links.slice(0,5))
    .then((links) => links.map((l) => Url.resolve(base, l)))
    .then((urls) => urls.map(promiseGET))
    .then((artpromises) => Promise.all(artpromises))
    .then((responses) =>
      Promise.all(responses.map((res) => promiseDOM(res.body, [], res)))
    )
    .then((wins) =>
      wins.map(({ window, passon }) => parseArticle(window, passon))
    )
    .then(finalize)
    .catch(console.log);

  function fixToc(toc) {
    const window = toc.window;
    const document = window.document;
    const contents = window.document.body.querySelector(`.issue-contents`);
    contents.querySelector(`.switcher`).remove();
    for (let a of contents.querySelectorAll(`a[href]`)) {
      if (!a.href.startsWith("/artikel")) {
        a.remove();
        continue;
      }
      a.href = path.basename(a.href);
    }
    for (let img of contents.querySelectorAll("img")) {
      img.remove();
    }
    fixCrap(contents, document);

    toc.body = contents.innerHTML;
    delete toc.window;
  }

  function finalize(articles) {
    fixToc(book.pages.find((page) => page.href === `toc`));

    for (let article of articles) {
      book.pages.push(article);
    }
    createEpub();
  }

  function setCover(window) {
    book.cover =
      base + window.document.querySelector(".cover-image").getAttribute("src");

    const titlepage = {
      title: `titlepage`,
      toc: false,
      hidden: false,
      url: base,
      href: `titlepage.xhtml`,
      body: `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
    <head>
        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
        <meta name="calibre:cover" content="true"/>
        <title>Cover</title>
        <style type="text/css" title="override_css">
            @page {padding: 0pt; margin:0pt}
            body { text-align: center; padding:0pt; margin: 0pt; }
        </style>
    </head>
    <body>
        <div>
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 500 649" preserveAspectRatio="none">
                <image width="500" height="649" xlink:href="assets/${path.basename(
                  book.cover
                )}"/>
            </svg>
        </div>
    </body>
</html>`,
    };
    book.pages.push(titlepage);
    return window;
  }

  function setInitialToc(window) {
    const toc = {
      title: `In deze editie`,
      toc: true,
      hidden: false,
      url: base,
      href: `toc`,
      window,
    };
    book.pages.push(toc);
    return window;
  }

  function getLinks(window) {
    const doc = window.document,
      links = [...doc.querySelectorAll('a[href^="/artikel"]')].map((a) =>
        a.getAttribute("href")
      );
    return links;
  }

  // function addAuthorPage({ window, passon }) {
  //   const page = {},
  //     bio = window.document.querySelector(`.author-bio`);
  //   if (bio) {
  //     (page.title = bio.querySelector(`h1`).innerHTML), (page.toc = false);
  //     page.hidden = false;
  //     page.url = base;
  //     page.href = path.basename(passon);

  //     for (let img of bio.querySelectorAll("img")) {
  //       img.setAttribute(
  //         "src",
  //         Url.resolve(base, img.getAttribute("src").replace(/\?.*$/, ""))
  //       );
  //     }

  //     page.body = bio.innerHTML;
  //   }
  //   book.pages.push(page);
  //   return page;
  // }

  function parseArticle(win, res) {
    const document = win.document,
      article = {};
    try {
      const articleArticle = document.querySelector(`article.groene-default`);
      article.title = articleArticle
        .querySelector(`header h1`)
        .textContent.trim();
      article.subtitle = articleArticle
        .querySelector(`header h2`)
        .textContent.trim();
      article.description = articleArticle.querySelector(`header p`).outerHTML;
      article.toc = true;
      article.hidden = false;
      article.url = base; //res.request.uri.href;
      article.href = path.basename(res.request.uri.pathname);
      // const authorelts = articleArticle.querySelectorAll(`a[href^="/auteur/"]`);
      // for (let author of authorelts) {
      //   if (!book.authors.has(author.href)) {
      //     let promise = promiseGET(Url.resolve(base, author.href)).then((res) =>
      //       promiseDOM(res.body, [], author.href)
      //     );
      //     book.authors.set(author.href, promise);
      //     author.href = path.basename(author.href);
      //   }
      // }
      // Moulding the article to our wishes
      const body = document.querySelector(`.article-body`);
      fixCrap(articleArticle, document);
      for (let a of articleArticle.querySelectorAll("a[href]")) {
        const replacement = document.createElement("span");
        replacement.innerHTML = a.innerHTML;
        a.parentNode.replaceChild(replacement, a);
      }
      //      const asides = document.querySelectorAll(".article-aside-thumb");

      article.body = articleArticle.innerHTML;
      // @todo: improve, contains links to
      //         `
      // ${document.querySelector(".article-header").innerHTML}
      // ${document.querySelector(".article-meta").innerHTML}
      // ${[...asides].map((aside) => aside.outerHTML)}
      // ${body.innerHTML}`;

      // We used to remove empty paragraphs - does not seem nec.

      // We used to remove querystrings from images - does not
      // seem nec. - but they are now in figures and a tags - that
      // may need some work.

      //       console.log(`${article.title} -- ${article.subtitle}
      // URL: ${article.href}
      // ====`);
    } catch (e) {
      throw new Error(`Error parsing article ${article.url}: ${e}`);
    } finally {
      return article;
    }
  }
}

function createEpub() {
  const Peepub = require("pe-epub"),
    myPeepub = new Peepub(book),
    pad = "00",
    filename =
      "GroeneAmsterdammer#" +
      (pad + book.issue.split("/").pop()).slice(-pad.length) +
      ".epub",
    tmppath = path.join("/tmp/"),
    newpath = path.join(process.cwd(), filename);

  myPeepub
    .create(tmppath)
    .then(function (filePath) {
      cp(filePath, newpath, function (err) {
        if (err) console.warn(`Error copying ${filePath} to ${newpath}`);
        else console.log(filename);
      });
    })
    .catch((err) => console.error(err));
}

login();
