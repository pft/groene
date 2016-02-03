var fs = require('fs');
var userdata = require('../config.json');
var request = require('request').defaults({jar: true})
var cheerio = require('cheerio');
var Url = require('url');
var path = require('path');
var cp = require('cp');
var base = 'https://www.groene.nl';

var book = {
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
  issue : process.argv[2] || null, // To be set after login
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

var Helper = {
  login_url : Url.resolve(base, 'gebruiker/inloggen')
}

function login(){
  request
    .get({'uri' : Helper.login_url},
         function(error, response, body) {
           var $ = cheerio.load(body);
           var $token = $("#new_user.full-page-form input[name=authenticity_token]");
           var name = $token.attr('name');
           var token = $token.val();
           // console.log(name + " -> " + token);
           var data = {
             authenticity_token : token,
             'user[email]' : userdata.user,
             'user[password]' : userdata.pass
           }
           request.post({'uri' : Helper.login_url,
                         form: data,

                         followAllRedirects : true
                        }, afterLogin)
         })
}

function afterLogin(err, res, body){
  if (!book.issue) {
    var $ = cheerio.load(body),
        issue = $('a[href^="/2016/"]:not([href$="pdf"])')
        .attr('href');
    book.issue = issue;
  }
  // Make sure issue starts with leading '/'.
  book.issue = Url.resolve('/', book.issue);
  book.setTitle();
  if ( Boolean(process.stdout.isTTY) )
    console.log('Downloading issue', book.issue.substr(1), 'from', book.getUrl(), 'as',
                '"' + book.title + '"');
  request.get({uri : book.getUrl(),
               followAllRedirects : true },
              parseIndex);
}

function notReady(soon){
  console.warn('Issue ' + book.issue + ' not (yet) available')
  if (soon)
    console.warn('... but it soon will be');
  else {
    console.warn('=========================')
    console.warn('To download another issue than the one from this week,')
    console.warn('provide this program with the issue number, e.g.:');
    console.warn(process.argv[0], process.argv[1], '2015/17_18 (for a "dubbeldik nummer") or:');
    console.warn(process.argv[0], process.argv[1], '1994/7 (the oldest Groene available at the time of writing)');
  }
  process.exit(11);
}

function parseIndex(err, res, body){
  if (res.statusCode === 404
      || (body.indexOf(404) > -1)) {
    notReady();
  }
  var $ = cheerio.load(body);
  book.cover = base + $('.cover img').attr('src');
  var tagPages = {};

  $('#column-everyone section.category-articles')
    .each(function(n){
      var category = $(this).find('h3').text();
      // console.warn('category', category);
      book.categories[category] = [];
      var tocArticle = {
        title : '» ' + category,
        url : Url.resolve(base, 'category/' + category),
        href : category,
        hidden: true,
        toc : true,             // maybe not...
        body : '<h3>' + category + '</h3>'
      }
      book.pages.push(tocArticle);
      $(this).find('article').each(function(n){

        var article =
              { title : $(this).find('h4').text(),
                description : $(this).find('h5').text(),
                url : Url.resolve(base, $(this).find('a').attr('href')),
                href : path.basename($(this).find('a').attr('href')),
                toc : true,
                author : $(this).find('p').text().replace(/^door /, '') };

        // console.warn('article', article.title, article.url);

        book.pages.push(article);
        request.get(article.url, function(err, res, body){
          var $ = cheerio.load(body);
          var $body = $('.main-article');
          if (!article.description) article.description = $body.find('.intro').text();

          tocArticle.body += '<h4><a href="' + article.href + '">' + article.title + '</a></h4>';
          tocArticle.body += '<p class="summary">' + article.description + '</p>';
          tocArticle.body += '<p class="credits">door ' + article.author + '</p>';

          $body.find('footer, .article-social-top, time').remove();
          // Remove empty paragraphs.
          $body.find('p:empty').remove();
          // Remove any slideshow images after the first (they are
          // present further on in the article)
          $body.find('.slideshow a~a').remove();
          $body.find('img').each(function(){
            $(this).attr('src', $(this).attr('src').replace(/\?.*$/, ''));
          });
          $body.find('blockquote').each(function(){
            if ($(this).text().charAt(0) === "‘")
              $(this).addClass('minhair');
          });
          $body.find('.T_tekst_artikel,'
                    + '.T_tekst_artikel_geen_inspring,'
                    + '.T_tekst_artikel_kort,'
                    + '.T_tekst_artikel_lang,'
                    + '.T_tekst_naschrift_lijn')
          .attr('class', null);
          $body.find('.T_tekst_kleinkapitaal').each(function(){
            $(this).replaceWith($('<abbr>' + $(this).text().toUpperCase() + '</abbr>'))
          })
          // Do not let links open browser.
          $body.find('header img, .main-article-content body img')
            .each(function(){
              $(this).attr('src', Url.resolve(base, $(this).attr('src')))
            })
          $body.find('.author').html($body.find('.author').text())
          $body.find('.credits').html($body.find('.credits').text())
          $body
            .find('.tags a')
            .map(function(){
              var tag = path.basename($(this).attr('href'));
              $(this).attr('href', tag);
              var title = $(this).text();
              if (!tagPages[tag]) tagPages[tag] = {
                title : title,
                body  : '<h3>' + title + '</h3>',
                href  : tag,
                toc   : false,
                hidden: true
              };
              tagPages[tag].body += '<h4><a href="' + article.href + '">' + article.title + '</a></h4>';
              tagPages[tag].body += '<p class="credits">door ' + article.author + '</p>';
              tagPages[tag].body += '<p class="description">' + article.description  + '</p>';
            })
          article.body =
            ( $body.find('.tags').html() ?
              '<div class="tags">' + $body.find('.tags').html() + "</div>"
              : '' )
            + $body.find('header').html()
            + ( $body.find('.main-article-content body').html() // Fix DOCTYPE bug on website
                || $body.find('.main-article-content').html() )
          if (book.readyForPrinting()){
            Object.keys(tagPages).forEach(function(tagPage){
              book.pages.push(tagPages[tagPage]);
            });
            createEpub();
          }
        });
        // console.warn(article);
        // book.categories[category].push(article);
      });
    }).length || notReady(true);
}

function createEpub(){
  var Peepub = require('pe-epub');
  //console.warn(book);
  var myPeepub = new Peepub(book);
  var pad      = "00";
  var filename = 'GroeneAmsterdammer#'
      + (pad+book.issue.split('/').pop()).slice(-pad.length)
      + '.epub' ;
  var tmppath = path.join('/tmp/');
  var newpath = path.join(process.cwd(), filename)
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
