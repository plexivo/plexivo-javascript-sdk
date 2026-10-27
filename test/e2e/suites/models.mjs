// The relation helpers from whichever SDK copy is under test.
import {loadSdk} from '../lib.mjs';

const {sdk} = await loadSdk();
export const {belongsTo, hasOne, hasMany, manyToMany} = sdk;
