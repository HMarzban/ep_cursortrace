'use strict';

let initiated = false;
let last = undefined;
let globalKey = 0;

const htmlSubstr = (str, count) => {
  const div = document.createElement('div');
  div.innerHTML = str;

  const track = (el) => {
    if (count > 0) {
      const len = el.data.length;
      count -= len;
      if (count <= 0) {
        el.data = el.substringData(0, el.data.length + count);
      }
    } else {
      el.data = '';
    }
  };

  const walk = (el, fn) => {
    let node = el.firstChild;
    if (!node) return;
    do {
      if (node.nodeType === 3) {
        fn(node);
        //          Added this >>------------------------------------<<
      } else if (node.nodeType === 1 && node.childNodes && node.childNodes[0]) {
        walk(node, fn);
      }
    } while (node = node.nextSibling); /* eslint-disable-line no-cond-assign */
  };
  walk(div, track);
  return div.innerHTML;
};

const wrap = (target) => {
  const newtarget = $('<div></div>');
  const nodes = target.contents().clone(); // the clone is critical!
  if (!nodes) return;
  nodes.each(function () {
    if (this.nodeType === 3) { // text
      let newhtml = '';
      const text = this.wholeText; // maybe "textContent" is better?
      for (let i = 0; i < text.length; i++) {
        if (text[i] === ' ') {
          newhtml += `<span data-key=${globalKey}> </span>`;
        } else {
          newhtml += `<span data-key=${globalKey}>${text[i]}</span>`;
        }
        globalKey++;
      }
      newtarget.append($(newhtml));
    } else { // recursion FTW!
      // console.log("recursion"); // IE handles recursion badly
      $(this).html(wrap($(this))); // This really hurts doing any sort of count..
      newtarget.append($(this));
    }
  });
  return newtarget.html();
};

export const aceEditorCSS = (hookName, cb) => ['/ep_cursortrace/static/css/cursortrace.css'];

export const aceInitInnerdocbodyHead = (hookName, args, cb) => {
  const url = '../static/plugins/ep_cursortrace/static/css/ace_inner.css';
  args.iframeHTML.push(`<link rel="stylesheet" type="text/css" href="${url}"/>`);
  cb();
};

export const postAceInit = (hookName, args, cb) => {
  initiated = true;

  // create a limited doc pageview
  const aceInner = $('iframe[name="ace_outer"]').contents()
      .find('iframe[name="ace_inner"]').contents();

  const innerhtml = aceInner.find('html');
  const newIframe = aceInner.find('head link').clone(true); // clone stylesheet

  let iframe = document.createElement('iframe');
  iframe.id = 'inerDocMirror';
  iframe = $(iframe).css({
    'position': 'fixed',
    'width': '100%',
    'margin': 'auto',
    'left': '50%',
    'transform': 'translateX(-50%)',
    'border': 'none',
    'background': 'purple',
    'z-index': '-999',
    'opacity': '0',
  });

  innerhtml.prepend(iframe);
  innerhtml.find('#inerDocMirror').contents().find('head').html(newIframe);
  innerhtml.find('#inerDocMirror').contents().find('body').attr({
    id: 'innerdocbody',
    class: 'innerdocbody doesWrap ltr static',
    style: 'overflow: hidden',
  });

  cb();
};

export const getAuthorClassName = (author) => {
  if (!author) return false;
  const authorId = author.replace(/[^a-y0-9]/g, (c) => {
    if (c === '.') return '-';
    return `z${c.charCodeAt(0)}z`;
  });
  return `ep_real_time_chat-${authorId}`;
};

export const className2Author = (className) => {
  if (className.substring(0, 7) === 'author-') {
    return className.substring(7).replace(/[a-y0-9]+|-|z.+?z/g, (cc) => {
      if (cc === '-') { return '.'; } else if (cc.charAt(0) === 'z') {
        return String.fromCharCode(Number(cc.slice(1, -1)));
      } else {
        return cc;
      }
    });
  }
};

export const aceEditEvent = (hookName, args) => {
  // Note: last is a tri-state: undefined (when the pad is first loaded)
  // null (no last cursor) and [line, col]
  // The AceEditEvent because it usually applies to selected items and isn't
  // really so mucha bout current position.
  const caretMoving = ((args.callstack.editEvent.eventType === 'handleClick') ||
      (args.callstack.type === 'handleKeyEvent') || (args.callstack.type === 'idleWorkTimer'));
  if (caretMoving && initiated) { // Note that we have to use idle timer to get the mouse position
    const Y = args.rep.selStart[0];
    const X = args.rep.selStart[1];
    if (!last || Y !== last[0] || X !== last[1]) { // If the position has changed
      const myAuthorId = pad.getUserId();
      const padId = pad.getPadId();
      // Create a cursor position message to send to the server
      const message = {
        type: 'cursor',
        action: 'cursorPosition',
        locationY: Y,
        locationX: X,
        padId,
        myAuthorId,
      };
      last = [];
      last[0] = Y;
      last[1] = X;

      // console.log("Sent message", message);
      pad.collabClient.sendMessage(message); // Send the cursor position message to the server
    }
  }
  return;
};

export const handleClientMessage_CUSTOM = (hook, context, cb) => {
  /* I NEED A REFACTOR, please */
  // A huge problem with this is that it runs BEFORE the dom has
  // been updated so edit events are always late..

  const action = context.payload.action;
  const authorId = context.payload.authorId;
  if (pad.getUserId() === authorId) return false;
  // Dont process our own caret position (yes we do get it..) -- This is not a bug
  const authorClass = exports.getAuthorClassName(authorId);

  const innerhtml = $('iframe[name="ace_outer"]').contents().find('iframe').contents().find('html');
  const inerDocMirror = innerhtml.find('#inerDocMirror').contents();

  if (action === 'cursorPosition') {
    // an author has sent this client a cursor position, we need to show it in the dom
    let authorName = context.payload.authorName;
    if (authorName === 'null' || authorName == null) {
      // If the users username isn't set then display a smiley face
      authorName = '😊';
    }
    // +1 as Etherpad line numbers start at 1
    const y = context.payload.locationY + 1;
    let x = context.payload.locationX;
    let stickUp = false;

    // Get the target Line
    const div = $('iframe[name="ace_outer"]').contents()
        .find('iframe').contents().find('#innerdocbody').find(`div:nth-child(${y})`);

    // Is the line visible yet?
    if (div.length !== 0) {
      let top = $(div).offset().top; // A standard generic offset
      // The problem we have here is we don't know the px X offset of the caret from the user
      // Because that's a blocker for now lets just put a nice little div on the left hand side..
      // SO here is how we do this..
      // Get the entire string including the styling
      // Put it in a hidden SPAN that has the same width as ace inner
      // Delete everything after X chars
      // Measure the new width -- This gives us the offset without modifying the ACE Dom
      // Due to IE sucking this doesn't work in IE....

      // Get the HTML
      const html = $(div).html();

      // build an ugly ID, makes sense to use authorId as authorId's cursor can only exist once
      const authorWorker = `hiddenUgly${exports.getAuthorClassName(authorId)}`;

      // if Div contains block attribute IE h1 or H2 then increment by the number
      // This is horrible but a limitation because I'm parsing HTML
      if ($(div).children('span').length < 1) { x -= 1; }

      // Get the new string but maintain mark up
      const newText = htmlSubstr(html, x);

      // A load of ugly HTML that can prolly be moved to CSS
      const newLine = `
        <span
          style="display:block"
          id='${authorWorker}'
          class='ghettoCursorXPos'
        >
         ${newText}
        </span>
      `;

      // Set the globalKey to 0, we use this when we wrap the objects in a datakey
      globalKey = 0; // It's bad, messy, don't ever develop like this.

      // Add the HTML to the DOM
      inerDocMirror.find('body').append(newLine);

      // Get the worker element
      const worker = inerDocMirror.find(`body #${authorWorker}`);

      // Wrap the HTML in spans so we can find a char
      $(worker).html(wrap($(worker), x));

      // Get the Left offset of the x span
      const span = $(worker).find('[data-key]').last();
      const lastSpanHasChar = $(worker).find('span[class^=\'author-\']').find('[data-key]').last();
      // Get the width of the element (This is how far out X is in px);
      let left;
      if (span.length !== 0) {
        left = span.position().left;
      } else {
        // empty span.
        left = 0;
      }
      if (lastSpanHasChar.length) {
        left = lastSpanHasChar.position().left + lastSpanHasChar.width();
      }

      // Get the height of the element minus the inner line height
      const height = worker.height(); // the height of the worker
      top = (top + height) - (lastSpanHasChar.height() + 13);
      // plus the top offset minus the actual height of our focus span
      if (top <= 0) { // If the tooltip wont be visible to the user because it's too high up
        stickUp = true;
        top += (lastSpanHasChar.height() * 2);
        if (top < 0) { top = 0; } // handle case where caret is in 0,0
      }

      const closectHeader = lastSpanHasChar.closest(':header');

      // if the caret is in the heading line
      if (closectHeader.length) {
        top -= parseInt(closectHeader.css('marginTop')) - 13;
        left += parseInt($(worker).parent().css('paddingLeft')) * 2;
      }

      // Remove the element
      inerDocMirror.find(`body #${authorWorker}`).remove();

      // Author color
      const users = pad.collabClient.getConnectedUsers();
      const outBody = $('iframe[name="ace_outer"]').contents()
          .find('iframe').contents().find('html');

      $.each(users, (user, value) => {
        if (value.userId === authorId) {
          const colors = pad.getColorPalette(); // support non set colors
          let color;
          if (colors[value.colorId]) {
            color = colors[value.colorId];
          } else {
            color = value.colorId; // Test for XSS
          }

          // Remove all divs that already exist for this author
          outBody.find(`.caret-${authorClass}`).remove();

          // Location of stick direction IE up or down
          const location = stickUp ? 'stickUp' : 'stickDown';

          // Create a new Div for this author
          const $indicator = $(`
            <div 
              class='caretindicator ${location} caret-${authorClass}'
              style='height:16px;left:${left}px;top:${top}px;background-color:${color}'
            >
              <p class='stickp ${location}'></p>
            </div>
          `);
          $indicator.attr('title', authorName);
          $indicator.find('p').text(authorName);
          $(outBody).append($indicator);

          // After a while, fade it out :)
          // setTimeout(() => {
          //   $indicator.fadeOut(500, () => {
          //     $indicator.remove();
          //   });
          // }, 2000);
        }
      });
    }
  }
  return cb();
};
