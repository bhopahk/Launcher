/*
Copyright (c) 2019 Matt Worzala <bhop.me>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import React from 'react';
import { Switch } from '../input/Input';

const SettingsField = (props) => {
    return (
        <div className="settings-field">
            <h2>{props.title}{props.beta ? (<span className="badge">BETA</span>) : null}{props.ni ? (<span className="badge">Not Implemented</span>) : null}</h2>
            <h3 className={props.switch ? 'short' : ''}>{props.description}&nbsp;{props.note ? (<span>{props.note}</span>) : null}</h3>
            {React.Children.map(props.children, child => {
                return React.cloneElement(child, {
                    getValue: () => getConfigValue(`${props.parentId}/${child.props.id}`).value,
                    setValue: value => setConfigValue(`${props.parentId}/${child.props.id}`, value),
                });
            })}
        </div>
    );
};

const SettingsSwitch = (props) => {
    return (
        <div className="absolute-switch">
            <Switch {...props} />
        </div>
    );
};

export {
    SettingsField,
    SettingsSwitch,
}

const getConfigValue = path => {
    return window.ipc.sendSync('config:get', path);
};

const setConfigValue = (path, value) => {
    window.ipc.send('config:set', {
        path, value,
    })
};
