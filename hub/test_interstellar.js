const axios = require('axios');
const token = '1a77d2d476a34db48dc44790c2d29c6f';
const jfUrl = 'http://192.168.2.54:1000';
const title = 'Interstellar';

(async () => {
    try {
        console.log('Testing Exact Match for:', title);
        const queryUrl = jfUrl + '/Items?IncludeItemTypes=Movie,Series&Recursive=true&searchTerm=' + title;
        const response = await axios.get(queryUrl, {
            headers: { 'X-Emby-Token': token }
        });
        console.log('Hits:', response.data.Items.length);
        if (response.data.Items.length > 0) {
            console.log('First hit:', response.data.Items[0].Name, response.data.Items[0].Id);
        }
    } catch (e) {
        console.log('Error:', e.message);
    }
})();
