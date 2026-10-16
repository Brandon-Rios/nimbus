// Fixes common typos in the message box as you type, when a word is finished (space or punctuation).
// Backspace right after a fix puts your original word back, and that word is left alone afterwards.
const WORDS = `
im:I'm ive:I've dont:don't cant:can't wont:won't didnt:didn't doesnt:doesn't isnt:isn't arent:aren't wasnt:wasn't
werent:weren't havent:haven't hasnt:hasn't hadnt:hadn't couldnt:couldn't shouldnt:shouldn't wouldnt:wouldn't thats:that's whats:what's
theres:there's heres:here's youre:you're theyre:they're weve:we've youve:you've theyve:they've itll:it'll
teh:the hte:the taht:that thier:their recieve:receive recieved:received beleive:believe belive:believe acheive:achieve wierd:weird
seperate:separate seperately:separately definately:definitely definitly:definitely occured:occurred occurence:occurrence
accomodate:accommodate adress:address alot:a_lot becuase:because becasue:because beacuse:because bcause:because untill:until wich:which
whcih:which wiht:with jsut:just juts:just knwo:know konw:know realy:really reccomend:recommend recomend:recommend
reccomended:recommended recomended:recommended reccommend:recommend tommorow:tomorrow tomorow:tomorrow tommorrow:tomorrow goverment:government
enviroment:environment existance:existence independant:independent neccessary:necessary necesary:necessary noticable:noticeable
occassion:occasion persistant:persistent posible:possible publically:publicly sucess:success succesful:successful successfull:successful
suprise:surprise truely:truly writting:writing wrting:writing begining:beginning calender:calendar comming:coming commited:committed
completly:completely concious:conscious finaly:finally foward:forward freind:friend garantee:guarantee grammer:grammar happend:happened
immediatly:immediately interupt:interrupt knowlege:knowledge libary:library maintainance:maintenance maintenence:maintenance mispell:misspell
paramter:parameter parameterss:parameters peice:piece prefered:preferred priviledge:privilege probaly:probably probly:probably
reponse:response responce:response sentance:sentence similiar:similar strenght:strength tounge:tongue twelth:twelfth usualy:usually
wether:whether whereever:wherever yeild:yield adn:and nad:and fro:for waht:what wnat:want wnated:wanted
hwo:how thsi:this tihs:this soem:some smae:same tiem:time thnk:think thikn:think thnks:thanks thx:thanks pls:please plz:please
abotu:about aboutt:about agian:again agin:again alos:also alredy:already allready:already anyting:anything anythign:anything
everyting:everything evrything:everything somthing:something somethign:something nothign:nothing beter:better diffrent:different
differnt:different eveything:everything exmaple:example exampel:example feautre:feature fetaure:feature featrue:feature featuers:features
implment:implement impliment:implement implemnt:implement improvment:improvement improvments:improvements instaed:instead isntead:instead
lenght:length mesage:message messgae:message mesages:messages pasword:password passwrod:password permision:permission permisions:permissions
proxmxo:proxmox serivce:service servcie:service sevrer:server settigns:settings setings:settings shoudl:should shuold:should
coudl:could woudl:would whould:would updtae:update upadte:update uplaod:upload vesion:version verison:version
`.trim().split(/\s+/).map((p) => p.split(':')).reduce((m, [a, b]) => (m[a] = b.replace(/_/g, ' '), m), {});

const skip = new Set(); // words the user un-did; left alone for the rest of the session
let last = null;        // { el, start, fixed, original } for Backspace-to-undo

function matchCase(orig, fix) {
  if (orig === orig.toUpperCase() && orig.length > 1) return fix.toUpperCase();
  if (orig[0] === orig[0].toUpperCase()) return fix[0].toUpperCase() + fix.slice(1);
  return fix;
}

export function attachAutocorrect(el) {
  if (el.dataset.autocorrect) return;
  el.dataset.autocorrect = '1';
  el.setAttribute('spellcheck', 'true');
  el.setAttribute('autocapitalize', 'sentences');
  el.setAttribute('autocorrect', 'on');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && last && last.el === el && el.selectionStart === el.selectionEnd && el.selectionStart === last.start + last.fixed.length + 1) {
      e.preventDefault();
      const v = el.value, sep = v[last.start + last.fixed.length];
      el.value = v.slice(0, last.start) + last.original + sep + v.slice(last.start + last.fixed.length + 1);
      const pos = last.start + last.original.length + 1;
      el.setSelectionRange(pos, pos);
      skip.add(last.original.toLowerCase());
      last = null;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (e.key !== 'Backspace') last = null;
  });
  el.addEventListener('input', (e) => {
    if (e.inputType !== 'insertText' || !/^[\s.,!?;:)]$/.test(e.data || '')) return;
    const pos = el.selectionStart, v = el.value;
    const m = v.slice(0, pos - 1).match(/(^|[\s(“"'])([A-Za-z]+)$/);
    if (!m) return;
    const word = m[2], key = word.toLowerCase();
    // A lone "i" becomes "I"; everything else comes from the list above.
    let fix = key === 'i' ? 'I' : WORDS[key];
    if (!fix || skip.has(key) || /[`/@#]/.test(v.slice(Math.max(0, pos - 40), pos))) return; // leave code, paths and @mentions alone
    if (key !== 'i') fix = matchCase(word, fix);
    if (fix === word) return;
    const start = pos - 1 - word.length;
    el.value = v.slice(0, start) + fix + v.slice(pos - 1);
    const np = start + fix.length + 1;
    el.setSelectionRange(np, np);
    last = { el, start, fixed: fix, original: word };
  });
}
