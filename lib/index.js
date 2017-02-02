'use strict';

const fs = require('fs'),
      userdata = require('../config.json'),
      request = require('request').defaults({jar: true}),
      jsdom = require('jsdom'),
      Url = require('url'),
      path = require('path'),
      cp = require('cp'),
      base = 'https://www.groene.nl';

const book = {
  basetitle : "De Groene Amsterdammer",
  categories : ["News"],
  languages : ["nl-NL"],
  creator : {
    name : "Groene Amsterdammer",
    role : "aut",
    "file-as" : "Groene Amsterdammer"
  },
  publisher : "NV Weekblad De Groene Amsterdammer",
  css : fs.readFileSync(path.join(__dirname, 'style.css'),
                        {encoding:'utf-8'}),
  issue : Url.resolve('/', process.argv[2] || '/deze-week'), // Can be adjusted later on
  pages : []
};
// @todo: scrape http://www.groene.nl/pagina/colofon for contributors
// and add all authors.  See
// http://www.idpf.org/epub/20/spec/OPF_2.0.1_draft.htm#Section2.2.6
// for roles
// @todo (?) Add tags as subjects.
book.readyForPrinting = function(){
  return (book.pages.filter(function(page){
    return page.body !== undefined;
  })).length === book.pages.length;
}

book.getUrl = function(){
  return Url.resolve(base, book.issue);
};

book.setTitle = function(){
  // Set the title
  book.title = book.basetitle + ' #' + book.issue.split('/').pop();
}

const Helper = {
  login_url : Url.resolve(base, 'accounts/inloggen')
}

function login(){
  request
    .get({'uri' : Helper.login_url},
         function(error, response, body) {
           promiseDOM(body)
             .then(({window}) => {
               const token_name = `authenticity_token`,
                     $token = window.document.querySelector(`input[name=${token_name}]`),
                     authenticity_token = $token.value,
                     form = {
                       authenticity_token,
                       'user[email]' : userdata.user,
                       'user[password]' : userdata.pass
                     };
               console.log(`${token_name} → ${authenticity_token}`);
               request.post({uri : Helper.login_url,
                             form,
                             followAllRedirects : true
                            }, afterLogin)
             })
         })
}

function afterLogin(err, res, body){
  // NOTE the name of the issue *may* change after redirect
  if ( Boolean(process.stdout.isTTY) )
    console.log(`Downloading issue ${book.issue.substr(1)} from ${book.getUrl()}`);
  request.get({uri : book.getUrl(),
               followAllRedirects : true },
              parseIndex);
}

function notReady(soon){
  console.warn(`Issue ${book.issue} not (yet) available`)
  if (soon)
    console.warn(`... but it soon will be`);
  else {
    console.warn(`=========================
To download another issue than the one from this week,
provide this program with the issue number, e.g.:
${process.argv[0]}, ${process.argv[1]}, 2015/17_18 (for a "dubbeldik nummer") or:
${process.argv[0]}, ${process.argv[1]}, 1994/7 (the oldest Groene available at the time of writing)`);
  }
  process.exit(11);
}

function promiseDOM(body, scripts, passon){
  return new Promise(function(resolve, reject){
    jsdom.env(body, scripts, function(err, window){
      if (err)
        reject(err)
      else {
        resolve({window, passon});
      }
    });
  });
}

function promiseGET(url){
  return new Promise(function(resolve, reject){
    request.get(url, function(err, res){
      if (err)
        reject(err)
      else {
        resolve(res);
      }
    });
  });
}

function parseIndex(err, res, body){
  if (res.statusCode === 404) {
    notReady();
  }
  book.issue = res.request.uri.path;
  book.setTitle();

  promiseDOM(body,[])
    .then(({window})=>setCover(window))
    .then(getLinks)
    .then(links => [...new Set(links)]) // remove dupes
    // .then(links => links.slice(0,5))
    .then(links => links.map(l=>Url.resolve(base,l)))
    .then(urls => urls.map(promiseGET))
    .then(artpromises => Promise.all(artpromises))
    .then(responses => Promise.all(responses.map((res)=>promiseDOM(res.body, [], res))))
    .then(wins => wins.map(({window,passon})=>parseArticle(window,passon)))
    .then(finalize)
    .catch(console.log);

  function finalize(articles){
    for (let article of articles){
      book.pages.push(article)
    }

    createEpub();
  }

  function setCover(window){
    book.cover = base + window.document.querySelector('.cover-image').getAttribute('src');
    return window;
  }

  function getLinks(window){
    const doc = window.document,
          links = [...doc.querySelectorAll('.issue-toc-category a[href^="/artikel"]')]
          .map(a => a.getAttribute('href'));
    return links;
  }

  // function parseArticle(res){
  //   return promiseDOM(res.body)
  // }

  function parseArticle(win, res){
    const document = win.document,
          article = {};
    try {
      article.title = document.querySelector(`.article-title`).textContent.trim();
      article.subtitle = document.querySelector(`.article-subtitle`).textContent.trim();
      article.description = document.querySelector(`.article-body-wrapper p:first-of-type`).outerHTML;
      article.toc = true;
      article.hidden = false;
      article.url = base; //res.request.uri.href;
      article.href = path.basename(res.request.uri.pathname)
      const authorelt = document.querySelector(`.p-author`);
      if (authorelt){
        // Authors are not in Post-section (or, actually, there are many)
        article.author = authorelt.textContent.trim();
      }
      // Moulding the article to our wishes
      const body = document.querySelector(`.article-body-wrapper`);

      for (let img of document.querySelectorAll('img')) {
        img.setAttribute('src', Url.resolve(base, img.getAttribute('src').replace(/\?.*$/, '')));
      }

      for (let sc of document.querySelectorAll('.small-caps')) {
        let abbr = document.createElement('abbr');
        abbr.textContent = sc.textContent.toUpperCase();
        sc.parentNode.replaceChild(abbr, sc);
      }

      const asides = document.querySelectorAll('.article-aside-thumb');

      article.body = `
${document.querySelector('.article-header').innerHTML}
${document.querySelector('.article-meta').innerHTML}
${[...asides].map(aside=>aside.outerHTML)}
${body.innerHTML}`;

      // We used to remove empty paragraphs - does not seem nec.

      // We used to remove querystrings from images - does not
      // seem nec. - but they are now in figures and a tags - that
      // may need some work.

      // console.log(`${article.href} ${article.title} -- ${article.subtitle}
      // =====
      // ${article.description}
      // =====
      // Door ${article.author}`)


    } catch(e){
      throw new Error(`Error parsing article ${article.url}: ${e}`);
    } finally {
      return article;
    }
  }

  //  const $ = {};
  // [].forEach(function(n){
  //     const $anchor = $(this).find('a');
  //     let category;
  //     //console.warn('category', category);
  //     book.categories[category] = [];
  //     var tocArticle = {
  //       title : '» ' + category,
  //       url : Url.resolve(base, 'category/' + category),
  //       href : category,
  //       hidden: true,
  //       toc : true,             // maybe not...
  //       body : '<h3>' + category + '</h3>'
  //     }
  //     book.pages.push(tocArticle);
  //     $(this).find('article').each(function(n){

  //       var article =
  //             { title : $(this).find('h4').text(),
  //               description : $(this).find('h5').text(),
  //               url : Url.resolve(base, $(this).find('a').attr('href')),
  //               href : path.basename($(this).find('a').attr('href')),
  //               toc : true,
  //               author : $(this).find('p').text().replace(/^door /, '') };

  //       // console.warn('article', article.title, article.url);

  //       book.pages.push(article);
  //       request.get(article.url, function(err, res, body){
  //         var $ = cheerio.load(body);
  //         var $body = $('.main-article');
  //         if (!article.description) article.description = $body.find('.intro').text();

  //         tocArticle.body += '<h4><a href="' + article.href + '">' + article.title + '</a></h4>';
  //         tocArticle.body += '<p class="summary">' + article.description + '</p>';
  //         tocArticle.body += '<p class="credits">door ' + article.author + '</p>';

  //         $body.find('footer, .article-social-top, time').remove();
  //         // Remove empty paragraphs.
  //         $body.find('p:empty').remove();
  //         // Remove any slideshow images after the first (they are
  //         // present further on in the article)
  //         $body.find('.slideshow a~a').remove();

  //         $body.find('blockquote').each(function(){
  //           if ($(this).text().charAt(0) === "‘")
  //             $(this).addClass('minhair');
  //         });
  //         $body.find('.T_tekst_artikel,'
  //                   + '.T_tekst_artikel_geen_inspring,'
  //                   + '.T_tekst_artikel_kort,'
  //                   + '.T_tekst_artikel_lang,'
  //                   + '.T_tekst_naschrift_lijn')
  //         .attr('class', null);

  //         // Do not let links open browser.
  //         $body.find('header img, .main-article-content body img')
  //           .each(function(){
  //             $(this).attr('src', Url.resolve(base, $(this).attr('src')))
  //           })
  //         $body.find('.author').html($body.find('.author').text())
  //         $body.find('.credits').html($body.find('.credits').text())

  //         article.body =
  //           $body.find('header').html()
  //           + ( $body.find('.main-article-content body').html() // Fix DOCTYPE bug on website
  //               || $body.find('.main-article-content').html() )

  //         if (book.readyForPrinting()){
  //           createEpub();
  //         }
  //       });
  //       // console.warn(article);
  //       // book.categories[category].push(article);
  //     });
  //   }).length || notReady(true);
}

function createEpub(){
  const Peepub = require('pe-epub'),
        myPeepub = new Peepub(book),
        pad      = '00',
        filename = 'GroeneAmsterdammer#'
        + (pad+book.issue.split('/').pop()).slice(-pad.length)
        + '.epub',
        tmppath = path.join('/tmp/'),
        newpath = path.join(process.cwd(), filename);

  myPeepub.create(tmppath)
    .then(function(filePath){
      cp(filePath, newpath, function(err){
        if (err)
          console.warn(`Error copying ${filePath} to ${newpath}`)
        else
          console.log(filename);
      })
  });
}


login();
